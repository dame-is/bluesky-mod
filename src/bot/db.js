// The bot's state, in one SQLite file, through node:sqlite.
//
// A file rather than a database server, so running the bot needs nothing but
// Node. Point DATABASE_PATH (or DATA_DIR) at a volume that survives restarts.
// Losing it loses the decision log, which nothing rebuilds; the snapshot
// rebuilds itself.
//
// The file holds the moderation log (who was added, why, and what they wrote)
// and the bot's refresh token, so it is created readable by its owner only.
//
// Callers use a few verbs, with filters written as strings:
//
//   select('decision', { eq: { plan_id }, where: { band: 'neq.UNKNOWN' } })
//
// Filters understood in `where` (and `eq`/`is` shorthands):
//   eq.X  neq.X  gt.X  gte.X  lt.X  lte.X  like.*x*  in.(a,b)  is.null
//   not.is.null  is.true  is.false
//
// and `{ in: [a, b] }`, which binds each value as given. An `in.(...)` string
// has no escape for a double quote, so values from outside go in the array.
//
// Table and column names are checked against the schema before they reach
// SQL, and every value is a bound parameter.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'schema.sql',
);

/** Tables whose `id` is a UUID filled in here when a row arrives without one. */
const UUID_ID = new Set(['plan', 'audit', 'brief', 'memory', 'watch']);

let db = null;
let info = new Map(); // table -> { columns: Map(name -> type), pk: string[] }

function databasePath() {
  return (
    process.env.DATABASE_PATH ||
    path.join(process.env.DATA_DIR || 'data', 'bluesky-mod.db')
  );
}

/**
 * Open the database, creating the file and the tables if needed.
 *
 * Called lazily by every verb, so importing this module costs nothing. Tests
 * (and anything else that wants a throwaway store) pass ':memory:'.
 */
export function openDb(file = databasePath()) {
  if (db) return db;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Created empty with mode 0600 before SQLite opens it. SQLite gives the
    // -wal and -shm files the same mode as the database.
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600));
  }
  db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  info = new Map();
  for (const { name } of db
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .all()) {
    const cols = db.prepare(`pragma table_info("${name}")`).all();
    info.set(name, {
      columns: new Map(cols.map((c) => [c.name, String(c.type).toUpperCase()])),
      pk: cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    });
  }
  return db;
}

/** Close and forget the handle. For tests and shutdown. */
export function closeDb() {
  if (db) db.close();
  db = null;
  info = new Map();
}

function table(name) {
  openDb();
  const t = info.get(name);
  if (!t) throw new Error(`db: no table ${name}`);
  return t;
}

function column(t, tableName, name) {
  if (!t.columns.has(name)) {
    throw new Error(`db: ${tableName} has no column ${name}`);
  }
  return `"${name}"`;
}

// --- values in and out --------------------------------------------------------

function toDb(type, value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (type === 'JSON') return JSON.stringify(value);
  if (type === 'BOOLEAN') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function fromDb(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'JSON') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (type === 'BOOLEAN') return Boolean(value);
  return value;
}

function readRow(t, row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = fromDb(t.columns.get(k), v);
  return out;
}

/** A filter operand as the column's type would store it. */
function operand(type, raw) {
  if (type === 'BOOLEAN') {
    if (raw === 'true') return 1;
    if (raw === 'false') return 0;
  }
  return raw;
}

const STRAY_QUOTE =
  'db: an in.(...) value holds a double quote, which the list cannot carry; pass { in: [...] }';

/**
 * `in.(a,"b,c",d)` -> ['a', 'b,c', 'd']
 *
 * A quote may only open or close a whole value. Anywhere else it throws: read
 * loosely, it would merge the values after it into one and quietly match fewer
 * rows.
 */
function parseList(raw) {
  const inner = String(raw).replace(/^\(/, '').replace(/\)$/, '');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '"') {
      const opens = !quoted && (i === 0 || inner[i - 1] === ',');
      const closes = quoted && (i + 1 === inner.length || inner[i + 1] === ',');
      if (!opens && !closes) throw new Error(STRAY_QUOTE);
      quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quoted) throw new Error(STRAY_QUOTE);
  if (cur.length || inner.length) out.push(cur);
  return out;
}

const OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** One filter string, or `{ in: [...] }` -> [sql, params]. */
function condition(t, tableName, col, filter) {
  const c = column(t, tableName, col);
  const type = t.columns.get(col);
  if (Array.isArray(filter?.in)) {
    if (!filter.in.length) return ['0', []];
    return [`${c} in (${filter.in.map(() => '?').join(',')})`, filter.in.map((v) => toDb(type, v))];
  }
  const s = String(filter);
  if (s === 'is.null') return [`${c} is null`, []];
  if (s === 'not.is.null') return [`${c} is not null`, []];
  if (s === 'is.true') return [`${c} = 1`, []];
  if (s === 'is.false') return [`${c} = 0`, []];
  const dot = s.indexOf('.');
  const op = s.slice(0, dot);
  const rest = s.slice(dot + 1);
  if (op in OPS) return [`${c} ${OPS[op]} ?`, [operand(type, rest)]];
  if (op === 'like') return [`${c} like ?`, [rest.replace(/\*/g, '%')]];
  if (op === 'in') {
    const values = parseList(rest);
    if (!values.length) return ['0', []];
    return [`${c} in (${values.map(() => '?').join(',')})`, values.map((v) => operand(type, v))];
  }
  throw new Error(`db: filter ${s} on ${tableName}.${col} is not supported`);
}

function whereClause(tableName, opts = {}) {
  const t = table(tableName);
  const parts = [];
  const params = [];
  const add = ([sql, p]) => {
    parts.push(sql);
    params.push(...p);
  };
  for (const [col, val] of Object.entries(opts.eq || {})) {
    add(condition(t, tableName, col, `eq.${val}`));
  }
  for (const [col, val] of Object.entries(opts.is || {})) {
    add(condition(t, tableName, col, `is.${val}`));
  }
  for (const [col, val] of Object.entries(opts.where || {})) {
    for (const v of Array.isArray(val) ? val : [val]) {
      add(condition(t, tableName, col, v));
    }
  }
  if (opts.not_null) add(condition(t, tableName, opts.not_null, 'not.is.null'));
  return { sql: parts.length ? ` where ${parts.join(' and ')}` : '', params, t };
}

/**
 * `order: 'trust.desc,did.asc'`. Null sorts as larger than any value: last
 * ascending, first descending.
 */
function orderClause(t, tableName, order) {
  if (!order) return '';
  const terms = String(order)
    .split(',')
    .map((term) => {
      const [col, ...mods] = term.trim().split('.');
      const desc = mods.includes('desc');
      return `${column(t, tableName, col)} ${desc ? 'desc nulls first' : 'asc nulls last'}`;
    });
  return ` order by ${terms.join(', ')}`;
}

function selectList(t, tableName, select) {
  if (!select || select === '*') return '*';
  return select
    .split(',')
    .map((c) => column(t, tableName, c.trim()))
    .join(', ');
}

// --- the verbs ----------------------------------------------------------------

/** `select(table, { eq, is, where, select, order, limit, offset })` */
export async function select(tableName, opts = {}) {
  const { sql: where, params, t } = whereClause(tableName, opts);
  let sql = `select ${selectList(t, tableName, opts.select)} from "${tableName}"${where}`;
  sql += orderClause(t, tableName, opts.order);
  if (opts.limit) sql += ` limit ${Number(opts.limit)}`;
  if (opts.offset) sql += `${opts.limit ? '' : ' limit -1'} offset ${Number(opts.offset)}`;
  return openDb()
    .prepare(sql)
    .all(...params)
    .map((r) => readRow(t, r));
}

/**
 * Every matching row, with no limit. `order` is required so that a read of a
 * large table always comes back in a defined order.
 */
export async function selectAll(tableName, opts = {}) {
  const { order, ...rest } = opts;
  if (!order) {
    throw new Error(`selectAll(${tableName}) needs an order`);
  }
  return select(tableName, { ...rest, order, limit: undefined, offset: undefined });
}

/**
 * Insert rows, updating the given columns when the primary key already
 * exists. Columns a row does not mention are left alone on update and take
 * their default on insert.
 */
export async function upsert(tableName, rows) {
  if (!rows?.length) return 0;
  const t = table(tableName);
  const conn = openDb();
  // Rows of one batch usually share a shape, so each statement is prepared
  // once. A snapshot writes tens of thousands of edges, and this runs on the
  // thread that answers DMs.
  const statements = new Map();
  conn.exec('begin');
  try {
    for (const input of rows) {
      const row = { ...input };
      if (UUID_ID.has(tableName) && row.id == null) row.id = crypto.randomUUID();
      const cols = Object.keys(row).filter((k) => row[k] !== undefined);
      for (const c of cols) column(t, tableName, c);
      const updates = cols.filter((c) => !t.pk.includes(c));
      const conflict = t.pk.length
        ? updates.length
          ? ` on conflict (${t.pk.map((c) => `"${c}"`).join(', ')}) do update set ${updates
              .map((c) => `"${c}" = excluded."${c}"`)
              .join(', ')}`
          : ` on conflict do nothing`
        : '';
      const sql = `insert into "${tableName}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols
        .map(() => '?')
        .join(', ')})${conflict}`;
      if (!statements.has(sql)) statements.set(sql, conn.prepare(sql));
      statements.get(sql).run(...cols.map((c) => toDb(t.columns.get(c), row[c])));
    }
    conn.exec('commit');
  } catch (err) {
    conn.exec('rollback');
    throw err;
  }
  return rows.length;
}

/** `update(table, { eq, where }, patch)` */
export async function update(tableName, match, patch) {
  const { sql: where, params, t } = whereClause(tableName, match);
  if (!where) throw new Error(`db: refusing an update of every row in ${tableName}`);
  const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!cols.length) return null;
  const sql = `update "${tableName}" set ${cols
    .map((c) => `${column(t, tableName, c)} = ?`)
    .join(', ')}${where}`;
  openDb()
    .prepare(sql)
    .run(...cols.map((c) => toDb(t.columns.get(c), patch[c])), ...params);
  return null;
}

/** `del(table, { eq, where })` */
export async function del(tableName, match) {
  const { sql: where, params } = whereClause(tableName, match);
  if (!where) throw new Error(`db: refusing a delete of every row in ${tableName}`);
  openDb()
    .prepare(`delete from "${tableName}"${where}`)
    .run(...params);
  return null;
}

/** `count(table, { eq, is, where, not_null })` */
export async function count(tableName, opts = {}) {
  const { sql: where, params } = whereClause(tableName, opts);
  const row = openDb()
    .prepare(`select count(*) as n from "${tableName}"${where}`)
    .get(...params);
  return Number(row.n);
}

// --- functions ----------------------------------------------------------------

/**
 * How many finalised snapshots to keep. Each is one row per account anyone in
 * the owner's circle follows, which runs to tens of thousands, so a weekly
 * rebuild kept forever grows the file by that much every week.
 */
const KEEP_SNAPSHOTS = 4;

const FUNCTIONS = {
  /**
   * Turn a collected snapshot's raw edges into vouch counts.
   *
   * Refuses while any circle member is still pending, so every member has
   * been read or written off first. A member written off (counted in
   * circle.unreadable) contributes no edges, so its vouches are missing from
   * the count.
   */
  finalise_snapshot({ snapshot }) {
    const conn = openDb();
    const pending = conn
      .prepare('select count(*) as n from circle where taken_at = ? and follows_indexed_at is null')
      .get(snapshot).n;
    if (pending > 0) {
      throw new Error(`snapshot ${snapshot} is incomplete; ${pending} members still unindexed`);
    }
    conn.exec('begin');
    try {
      const res = conn
        .prepare(
          `insert into vouch (taken_at, did, vouches)
           select taken_at, target_did, count(distinct member_did)
           from circle_follow where taken_at = ?
           group by taken_at, target_did
           on conflict (taken_at, did) do update set vouches = excluded.vouches`,
        )
        .run(snapshot);
      conn.prepare('delete from circle_follow where taken_at = ?').run(snapshot);
      const old = conn
        .prepare('select distinct taken_at from circle order by taken_at desc limit -1 offset ?')
        .all(KEEP_SNAPSHOTS)
        .map((r) => r.taken_at);
      for (const takenAt of old) {
        conn.prepare('delete from vouch where taken_at = ?').run(takenAt);
        conn.prepare('delete from circle where taken_at = ?').run(takenAt);
        conn.prepare('delete from circle_follow where taken_at = ?').run(takenAt);
      }
      conn.exec('commit');
      return Number(res.changes);
    } catch (err) {
      conn.exec('rollback');
      throw err;
    }
  },
};

/** Call a named function, e.g. `rpc('finalise_snapshot', { snapshot })`. */
export async function rpc(fn, args = {}) {
  const f = FUNCTIONS[fn];
  if (!f) throw new Error(`db: no function ${fn}`);
  return f(args);
}
