// The bot's state: one SQLite file through node:sqlite, or a Postgres
// database when DATABASE_URL is set.
//
// A file by default, so running the bot needs nothing but Node. Point
// DATABASE_PATH (or DATA_DIR) at a volume that survives restarts. Losing it
// loses the decision log, which nothing rebuilds; the snapshot rebuilds
// itself.
//
// The store holds the moderation log (who was added, why, and what they
// wrote) and the bot's refresh token, so the file is created readable by its
// owner only. In Postgres the tables live in their own schema (DATABASE_SCHEMA,
// default bluesky_mod), so they never meet another table of the same name.
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
// SQL, and every value is a bound parameter. The SQL is written once, with
// `?` placeholders, and the two backends differ only where noted below.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'schema.sql',
);

/**
 * Columns added to tables after they first shipped. `create table if not
 * exists` leaves a table that is already there as it is, so a store made by an
 * older version gets these added at open. Nullable with no default, so rows
 * written before they existed read as null, which every reader takes as "the
 * way it was before". Types are written as schema.sql writes them.
 */
export const ADDED_COLUMNS = [
  // Which list a plan's writes went to. Null is MOD_LIST_URI, the only list
  // there was before multi-list mode.
  { table: 'plan', column: 'list_uri', type: 'text' },
];

/** Tables whose `id` is a UUID filled in here when a row arrives without one. */
const UUID_ID = new Set(['plan', 'audit', 'brief', 'memory', 'watch', 'shield_gate']);

/** A Postgres connection string, as opposed to a file path. */
export const isPostgresUrl = (s) => /^postgres(ql)?:\/\//i.test(String(s || ''));

/** The Postgres schema to use. A bare lowercase name, since it goes into SQL. */
export function pgSchema(env = process.env) {
  const name = String(env.DATABASE_SCHEMA || 'bluesky_mod').trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      `DATABASE_SCHEMA must be lowercase letters, digits and underscores, not "${name}"`,
    );
  }
  return name;
}

/**
 * The open store: { kind: 'sqlite', db } or { kind: 'pg', pool, ready, schema }.
 * `info` maps each table to its columns' types and its primary key.
 */
let backend = null;
let info = new Map();

function databasePath() {
  return (
    process.env.DATABASE_PATH ||
    path.join(process.env.DATA_DIR || 'data', 'bluesky-mod.db')
  );
}

/**
 * Open the store, creating the tables if needed.
 *
 * Called lazily by every verb, so importing this module costs nothing. Tests
 * (and anything else that wants a throwaway store) pass ':memory:'. SQLite
 * opens at once and returns its handle; Postgres returns a promise that
 * settles once the tables exist. `await openDb()` suits both.
 */
export function openDb(target = process.env.DATABASE_URL || databasePath()) {
  if (backend) return backend.kind === 'pg' ? backend.ready : backend.db;
  if (isPostgresUrl(target)) {
    const b = { kind: 'pg', pool: null, schema: pgSchema() };
    backend = b;
    b.ready = openPostgres(target, b.schema).then(
      (pool) => {
        b.pool = pool;
        return pool;
      },
      (err) => {
        // The next verb tries again rather than failing for good.
        if (backend === b) backend = null;
        throw err;
      },
    );
    return b.ready;
  }
  const file = target;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Created empty with mode 0600 before SQLite opens it. SQLite gives the
    // -wal and -shm files the same mode as the database.
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600));
  }
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  addColumnsSqlite(db);
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
  backend = { kind: 'sqlite', db };
  return db;
}

/** Close and forget the handle. For tests and shutdown. */
export async function closeDb() {
  const b = backend;
  backend = null;
  info = new Map();
  if (!b) return;
  if (b.kind === 'sqlite') {
    b.db.close();
    return;
  }
  const pool = await b.ready.catch(() => null);
  if (pool) await pool.end();
}

/** Is the open store Postgres? */
export function usingPostgres() {
  current();
  return backend?.kind === 'pg';
}

function current() {
  if (!backend) openDb();
  return backend;
}

/**
 * The store, ready to take a query. SQLite comes back synchronously, so its
 * queries still run in the order they were called, as they did before a
 * second backend existed.
 */
function ready() {
  const b = current();
  return b.kind === 'pg' ? b.ready.then(() => b) : b;
}

/** ADDED_COLUMNS for SQLite, which has no "add column if not exists". */
function addColumnsSqlite(db) {
  for (const { table, column, type } of ADDED_COLUMNS) {
    const have = db
      .prepare(`pragma table_info("${table}")`)
      .all()
      .some((c) => c.name === column);
    if (!have) db.exec(`alter table "${table}" add column "${column}" ${type}`);
  }
}

/** ADDED_COLUMNS for Postgres, as statements run inside the schema's transaction. */
export function addColumnsPg() {
  return ADDED_COLUMNS.map(
    ({ table, column, type }) =>
      `alter table "${table}" add column if not exists "${column}" ${pgDdl(type)}`,
  );
}

// --- Postgres -----------------------------------------------------------------

/**
 * schema.sql, as Postgres says it. The file is written for SQLite; these are
 * the only differences it uses.
 */
export function pgDdl(sql) {
  return sql
    .replace(
      /\(strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)\)/g,
      `(to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
    )
    .replace(
      /\binteger primary key autoincrement\b/g,
      'bigint generated by default as identity primary key',
    )
    .replace(/\binteger\b/g, 'bigint')
    .replace(/\bJSON\b/g, 'jsonb')
    .replace(/\bBOOLEAN\b/g, 'boolean');
}

const PG_TYPES = { jsonb: 'JSON', boolean: 'BOOLEAN', bigint: 'INTEGER', text: 'TEXT' };

async function openPostgres(url, schema) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    // count(*) and bigint columns arrive as strings by default.
    types: {
      getTypeParser: (oid, format) =>
        oid === 20 ? (v) => (v === null ? null : Number(v)) : pg.types.getTypeParser(oid, format),
    },
  });
  // An idle connection the server drops must not take the process with it;
  // the next query opens another.
  pool.on('error', () => {});
  try {
    await inTransaction(pool, async (client) => {
      await client.query(`create schema if not exists "${schema}"`);
      await client.query(`set local search_path to "${schema}"`);
      await client.query(pgDdl(fs.readFileSync(SCHEMA_FILE, 'utf8')));
      for (const sql of addColumnsPg()) await client.query(sql);
    });
    const cols = await pool.query(
      `select table_name, column_name, data_type
       from information_schema.columns where table_schema = $1`,
      [schema],
    );
    const keys = await pool.query(
      `select kcu.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.table_schema = tc.table_schema
        and kcu.table_name = tc.table_name
       where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = $1
       order by kcu.table_name, kcu.ordinal_position`,
      [schema],
    );
    const next = new Map();
    for (const r of cols.rows) {
      if (!next.has(r.table_name)) next.set(r.table_name, { columns: new Map(), pk: [] });
      next
        .get(r.table_name)
        .columns.set(r.column_name, PG_TYPES[r.data_type] || String(r.data_type).toUpperCase());
    }
    for (const r of keys.rows) next.get(r.table_name)?.pk.push(r.column_name);
    info = next;
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** `?` placeholders as `$1, $2, ...`. No SQL built here holds a literal `?`. */
function numbered(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${(i += 1)}`);
}

// --- the two backends ---------------------------------------------------------

/** A table's name in SQL. */
function tableName(b, name) {
  return b.kind === 'pg' ? `"${b.schema}"."${name}"` : `"${name}"`;
}

/** Rows, a row and a write, the same way for both. */
function all(b, sql, params) {
  if (b.kind === 'sqlite') return b.db.prepare(sql).all(...params);
  return b.pool.query(numbered(sql), params).then((r) => r.rows);
}

function run(b, sql, params) {
  if (b.kind === 'sqlite') return Number(b.db.prepare(sql).run(...params).changes);
  return b.pool.query(numbered(sql), params).then((r) => r.rowCount);
}

function table(name) {
  const t = info.get(name);
  if (!t) throw new Error(`db: no table ${name}`);
  return t;
}

function column(t, tableNameText, name) {
  if (!t.columns.has(name)) {
    throw new Error(`db: ${tableNameText} has no column ${name}`);
  }
  return `"${name}"`;
}

// --- values in and out --------------------------------------------------------

/** A boolean as the backend stores it: 1/0 in SQLite, true/false in Postgres. */
const bool = (b, v) => (b.kind === 'pg' ? Boolean(v) : v ? 1 : 0);

function toDb(b, type, value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (type === 'JSON') return JSON.stringify(value);
  if (type === 'BOOLEAN') return bool(b, value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function fromDb(type, value) {
  if (value === null || value === undefined) return null;
  // Postgres hands jsonb back parsed; SQLite hands back the text.
  if (type === 'JSON' && typeof value === 'string') {
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
function operand(b, type, raw) {
  if (type === 'BOOLEAN') {
    if (raw === 'true') return bool(b, true);
    if (raw === 'false') return bool(b, false);
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

/**
 * A text column, compared or sorted byte by byte. SQLite does that already;
 * Postgres follows the database's collation, which can order "did:plc:a" and
 * "did:plc:A", or two timestamps, differently from the bytes.
 */
function bytewise(b, t, col, c) {
  return b.kind === 'pg' && t.columns.get(col) === 'TEXT' ? `${c} collate "C"` : c;
}

/** One filter string, or `{ in: [...] }` -> [sql, params]. */
function condition(b, t, tableNameText, col, filter) {
  const c = column(t, tableNameText, col);
  const type = t.columns.get(col);
  if (Array.isArray(filter?.in)) {
    if (!filter.in.length) return ['1 = 0', []];
    return [`${c} in (${filter.in.map(() => '?').join(',')})`, filter.in.map((v) => toDb(b, type, v))];
  }
  const s = String(filter);
  if (s === 'is.null') return [`${c} is null`, []];
  if (s === 'not.is.null') return [`${c} is not null`, []];
  if (s === 'is.true') return [`${c} = ?`, [bool(b, true)]];
  if (s === 'is.false') return [`${c} = ?`, [bool(b, false)]];
  const dot = s.indexOf('.');
  const op = s.slice(0, dot);
  const rest = s.slice(dot + 1);
  if (op in OPS) {
    const lhs = op === 'eq' || op === 'neq' ? c : bytewise(b, t, col, c);
    return [`${lhs} ${OPS[op]} ?`, [operand(b, type, rest)]];
  }
  // SQLite's like ignores case for ASCII; Postgres's ilike is the same.
  if (op === 'like') {
    return [`${c} ${b.kind === 'pg' ? 'ilike' : 'like'} ?`, [rest.replace(/\*/g, '%')]];
  }
  if (op === 'in') {
    const values = parseList(rest);
    if (!values.length) return ['1 = 0', []];
    return [`${c} in (${values.map(() => '?').join(',')})`, values.map((v) => operand(b, type, v))];
  }
  throw new Error(`db: filter ${s} on ${tableNameText}.${col} is not supported`);
}

function whereClause(b, tableNameText, opts = {}) {
  const t = table(tableNameText);
  const parts = [];
  const params = [];
  const add = ([sql, p]) => {
    parts.push(sql);
    params.push(...p);
  };
  for (const [col, val] of Object.entries(opts.eq || {})) {
    add(condition(b, t, tableNameText, col, `eq.${val}`));
  }
  for (const [col, val] of Object.entries(opts.is || {})) {
    add(condition(b, t, tableNameText, col, `is.${val}`));
  }
  for (const [col, val] of Object.entries(opts.where || {})) {
    for (const v of Array.isArray(val) ? val : [val]) {
      add(condition(b, t, tableNameText, col, v));
    }
  }
  if (opts.not_null) add(condition(b, t, tableNameText, opts.not_null, 'not.is.null'));
  return { sql: parts.length ? ` where ${parts.join(' and ')}` : '', params, t };
}

/**
 * `order: 'trust.desc,did.asc'`. Null sorts as larger than any value: last
 * ascending, first descending.
 */
function orderClause(b, t, tableNameText, order) {
  if (!order) return '';
  const terms = String(order)
    .split(',')
    .map((term) => {
      const [col, ...mods] = term.trim().split('.');
      const desc = mods.includes('desc');
      const c = bytewise(b, t, col, column(t, tableNameText, col));
      return `${c} ${desc ? 'desc nulls first' : 'asc nulls last'}`;
    });
  return ` order by ${terms.join(', ')}`;
}

function selectList(t, tableNameText, select) {
  if (!select || select === '*') return '*';
  return select
    .split(',')
    .map((c) => column(t, tableNameText, c.trim()))
    .join(', ');
}

// --- the verbs ----------------------------------------------------------------

/** `select(table, { eq, is, where, select, order, limit, offset })` */
export async function select(name, opts = {}) {
  let b = ready();
  if (b.then) b = await b;
  const { sql: where, params, t } = whereClause(b, name, opts);
  let sql = `select ${selectList(t, name, opts.select)} from ${tableName(b, name)}${where}`;
  sql += orderClause(b, t, name, opts.order);
  if (opts.limit) sql += ` limit ${Number(opts.limit)}`;
  if (opts.offset) {
    // SQLite takes an offset only after a limit; -1 is no limit.
    const noLimit = b.kind === 'sqlite' && !opts.limit ? ' limit -1' : '';
    sql += `${noLimit} offset ${Number(opts.offset)}`;
  }
  return (await all(b, sql, params)).map((r) => readRow(t, r));
}

/**
 * Every matching row. Needs an order, so a caller that pages or compares two
 * reads gets them in the same order every time.
 */
export async function selectAll(name, opts = {}) {
  const { order, ...rest } = opts;
  if (!order) {
    throw new Error(`selectAll(${name}) needs an order`);
  }
  return select(name, { ...rest, order, limit: undefined, offset: undefined });
}

/** The columns of an upsert, checked, and its ON CONFLICT clause. */
function upsertShape(t, name, row) {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  for (const c of cols) column(t, name, c);
  const updates = cols.filter((c) => !t.pk.includes(c));
  const conflict = t.pk.length
    ? updates.length
      ? ` on conflict (${t.pk.map((c) => `"${c}"`).join(', ')}) do update set ${updates
          .map((c) => `"${c}" = excluded."${c}"`)
          .join(', ')}`
      : ' on conflict do nothing'
    : '';
  return { cols, conflict };
}

function withId(name, input) {
  const row = { ...input };
  if (UUID_ID.has(name) && row.id == null) row.id = crypto.randomUUID();
  return row;
}

/**
 * Insert rows, updating the given columns when the primary key already
 * exists. Columns a row does not mention are left alone on update and take
 * their default on insert. All of a call's rows go in, or none do.
 */
export async function upsert(name, rows) {
  if (!rows?.length) return 0;
  let b = ready();
  if (b.then) b = await b;
  const t = table(name);
  if (b.kind === 'pg') return upsertPg(b, t, name, rows);

  // Rows of one batch usually share a shape, so each statement is prepared
  // once. A snapshot writes tens of thousands of edges, and this runs on the
  // thread that answers DMs.
  const statements = new Map();
  b.db.exec('begin');
  try {
    for (const input of rows) {
      const row = withId(name, input);
      const { cols, conflict } = upsertShape(t, name, row);
      const sql = `insert into ${tableName(b, name)} (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols
        .map(() => '?')
        .join(', ')})${conflict}`;
      if (!statements.has(sql)) statements.set(sql, b.db.prepare(sql));
      statements.get(sql).run(...cols.map((c) => toDb(b, t.columns.get(c), row[c])));
    }
    b.db.exec('commit');
  } catch (err) {
    b.db.exec('rollback');
    throw err;
  }
  return rows.length;
}

/** Postgres takes at most 65,535 parameters in one statement. */
const PG_MAX_PARAMS = 30_000;

/**
 * Postgres: many rows per statement, since a round trip per row would make a
 * snapshot's tens of thousands of edges take minutes.
 *
 * Rows go in order, a run of rows with the same columns at a time. Within a
 * run only the last row for a key is sent: Postgres refuses a statement that
 * updates one row twice, and the last row is what row-by-row writes would
 * have left.
 */
async function upsertPg(b, t, name, rows) {
  const runs = [];
  for (const input of rows) {
    const row = withId(name, input);
    const shape = upsertShape(t, name, row);
    const key = shape.cols.join(',');
    let last = runs[runs.length - 1];
    if (!last || last.key !== key) {
      last = { key, shape, rows: new Map() };
      runs.push(last);
    }
    // A row with no key yet (an id the database numbers) is always new.
    const keyed = t.pk.length && t.pk.every((c) => row[c] != null);
    const pk = keyed ? JSON.stringify(t.pk.map((c) => row[c])) : crypto.randomUUID();
    last.rows.delete(pk);
    last.rows.set(pk, row);
  }
  await inTransaction(b.pool, async (client) => {
    for (const { shape, rows: byKey } of runs) {
      const { cols, conflict } = shape;
      const list = [...byKey.values()];
      const per = Math.max(1, Math.floor(PG_MAX_PARAMS / Math.max(1, cols.length)));
      for (let i = 0; i < list.length; i += per) {
        const chunk = list.slice(i, i + per);
        const values = chunk
          .map(() => `(${cols.map(() => '?').join(', ')})`)
          .join(', ');
        const params = chunk.flatMap((row) => cols.map((c) => toDb(b, t.columns.get(c), row[c])));
        await client.query(
          numbered(
            `insert into ${tableName(b, name)} (${cols.map((c) => `"${c}"`).join(', ')}) values ${values}${conflict}`,
          ),
          params,
        );
      }
    }
  });
  return rows.length;
}

/** `update(table, { eq, where }, patch)` */
export async function update(name, match, patch) {
  let b = ready();
  if (b.then) b = await b;
  const { sql: where, params, t } = whereClause(b, name, match);
  if (!where) throw new Error(`db: refusing an update of every row in ${name}`);
  const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!cols.length) return null;
  const sql = `update ${tableName(b, name)} set ${cols
    .map((c) => `${column(t, name, c)} = ?`)
    .join(', ')}${where}`;
  await run(b, sql, [...cols.map((c) => toDb(b, t.columns.get(c), patch[c])), ...params]);
  return null;
}

/** `del(table, { eq, where })` */
export async function del(name, match) {
  let b = ready();
  if (b.then) b = await b;
  const { sql: where, params } = whereClause(b, name, match);
  if (!where) throw new Error(`db: refusing a delete of every row in ${name}`);
  await run(b, `delete from ${tableName(b, name)}${where}`, params);
  return null;
}

/** `count(table, { eq, is, where, not_null })` */
export async function count(name, opts = {}) {
  let b = ready();
  if (b.then) b = await b;
  const { sql: where, params } = whereClause(b, name, opts);
  const rows = await all(b, `select count(*) as n from ${tableName(b, name)}${where}`, params);
  return Number(rows[0].n);
}

// --- functions ----------------------------------------------------------------

/**
 * How many finalised snapshots to keep, unless the caller says
 * (MOD_KEEP_SNAPSHOTS): the newest, which is scored against, and the one
 * before, which is used while a newer one cannot be read. Each full one is
 * one row per account anyone in the owner's circle follows, which runs to
 * hundreds of thousands for someone who follows a few thousand.
 */
const KEEP_SNAPSHOTS = 2;

/**
 * Run a function's steps in one transaction. A function is a generator that
 * yields ['all' | 'run', sql, params] and gets back the rows or the count of
 * rows changed. SQLite runs every step in one synchronous stretch, so nothing
 * else can run in the middle of it; Postgres awaits each.
 */
function runSteps(b, steps) {
  if (b.kind === 'sqlite') {
    b.db.exec('begin');
    try {
      let r = steps.next();
      while (!r.done) {
        const [kind, sql, params] = r.value;
        const stmt = b.db.prepare(sql);
        r = steps.next(kind === 'all' ? stmt.all(...params) : Number(stmt.run(...params).changes));
      }
      b.db.exec('commit');
      return r.value;
    } catch (err) {
      b.db.exec('rollback');
      throw err;
    }
  }
  return inTransaction(b.pool, async (client) => {
    let r = steps.next();
    while (!r.done) {
      const [kind, sql, params] = r.value;
      const res = await client.query(numbered(sql), params);
      r = steps.next(kind === 'all' ? res.rows : res.rowCount);
    }
    return r.value;
  });
}

const FUNCTIONS = {
  /**
   * Turn a collected snapshot's raw edges into vouch counts.
   *
   * Refuses while any circle member is still pending, so every member has
   * been read or written off first. A member written off (counted in
   * circle.unreadable) contributes no edges, so its vouches are missing from
   * the count.
   */
  *finalise_snapshot(b, { snapshot, keep = KEEP_SNAPSHOTS }) {
    const T = (n) => tableName(b, n);
    const [{ n }] = yield [
      'all',
      `select count(*) as n from ${T('circle')} where taken_at = ? and follows_indexed_at is null`,
      [snapshot],
    ];
    if (Number(n) > 0) {
      throw new Error(`snapshot ${snapshot} is incomplete; ${n} members still unindexed`);
    }
    const written = yield [
      'run',
      `insert into ${T('vouch')} (taken_at, did, vouches)
       select taken_at, target_did, count(distinct member_did)
       from ${T('circle_follow')} where taken_at = ?
       group by taken_at, target_did
       on conflict (taken_at, did) do update set vouches = excluded.vouches`,
      [snapshot],
    ];
    yield ['run', `delete from ${T('circle_follow')} where taken_at = ?`, [snapshot]];
    const pg = b.kind === 'pg';
    const old = yield [
      'all',
      `select taken_at from ${T('circle')} group by taken_at
       order by taken_at ${pg ? 'collate "C" ' : ''}desc ${pg ? '' : 'limit -1 '}offset ?`,
      [Math.max(1, keep)],
    ];
    for (const { taken_at: takenAt } of old) {
      for (const table of ['vouch', 'circle', 'circle_follow']) {
        yield ['run', `delete from ${T(table)} where taken_at = ?`, [takenAt]];
      }
    }
    return Number(written);
  },

  /**
   * Take the lease named `name` for `holder`, if it is free, stale (its
   * heartbeat older than `staleBefore`) or already theirs. Returns whoever
   * holds it afterwards.
   */
  *take_lease(b, { name, holder, now, staleBefore }) {
    const T = tableName(b, 'lease');
    yield [
      'run',
      `insert into ${T} as l (name, holder, heartbeat_at) values (?, ?, ?)
       on conflict (name) do update
         set holder = excluded.holder, heartbeat_at = excluded.heartbeat_at
         where l.heartbeat_at < ? or l.holder = excluded.holder`,
      [name, holder, now, staleBefore],
    ];
    const rows = yield ['all', `select holder, heartbeat_at from ${T} where name = ?`, [name]];
    return rows[0] ?? null;
  },

  /** A heartbeat, written only while `holder` still holds the lease. */
  *beat_lease(b, { name, holder, now }) {
    return yield [
      'run',
      `update ${tableName(b, 'lease')} set heartbeat_at = ? where name = ? and holder = ?`,
      [now, name, holder],
    ];
  },

  /** Let go of the lease, if `holder` still holds it. */
  *drop_lease(b, { name, holder }) {
    return yield [
      'run',
      `delete from ${tableName(b, 'lease')} where name = ? and holder = ?`,
      [name, holder],
    ];
  },

  // --- the panel's counts (src/panel/queries.js) ------------------------------
  // What the verbs above cannot ask for: sums and groups. Each is a read, and
  // each is written so SQLite and Postgres take the same text. Timestamps are
  // compared bytewise in Postgres, as the verbs compare them.

  /**
   * Per day since `since`: how many accounts were added, and how many came
   * off (an unblock, an undo, or both for the same account, counted once).
   * A typed block of someone already listed wrote nothing and is left out.
   */
  *panel_days(b, { since }) {
    const T = tableName(b, 'decision');
    const C = b.kind === 'pg' ? ' collate "C"' : '';
    const no = bool(b, false);
    const added = yield [
      'all',
      `select substr(acted_at, 1, 10) as day, count(*) as n from ${T}
       where action = 'list_add' and acted_at${C} >= ?
         and (already_listed is null or already_listed = ?)
       group by substr(acted_at, 1, 10)`,
      [since, no],
    ];
    const removed = yield [
      'all',
      `select u.day as day, count(distinct u.did) as n from (
         select substr(acted_at, 1, 10) as day, did from ${T}
           where action = 'list_remove' and acted_at${C} >= ?
         union all
         select substr(undone_at, 1, 10) as day, did from ${T}
           where action = 'list_add' and acted_at is not null and undone_at${C} >= ?
             and (already_listed is null or already_listed = ?)
       ) u group by u.day`,
      [since, since, no],
    ];
    const count = (rows) =>
      rows.map((r) => ({ day: r.day, n: Number(r.n) }));
    return { added: count(added), removed: count(removed) };
  },

  /**
   * Writes to the list since `since`, as the log has them: records created,
   * and accounts taken off. An unblock logs a removal and closes the add
   * that put the account there; that is one record deleted, counted once.
   */
  *panel_writes(b, { since }) {
    const T = tableName(b, 'decision');
    const C = b.kind === 'pg' ? ' collate "C"' : '';
    const [{ n: creates }] = yield [
      'all',
      `select count(*) as n from ${T}
       where action = 'list_add' and acted_at${C} >= ?
         and (already_listed is null or already_listed = ?)`,
      [since, bool(b, false)],
    ];
    const [{ n: deletes }] = yield [
      'all',
      `select count(distinct u.did) as n from (
         select did from ${T} where action = 'list_remove' and acted_at${C} >= ?
         union all
         select did from ${T}
           where action = 'list_add' and acted_at is not null and undone_at${C} >= ?
       ) u`,
      [since, since],
    ];
    return { creates: Number(creates), deletes: Number(deletes) };
  },

  /**
   * The decision log, one row per plan and kind of change, newest first.
   * A batch of five hundred is one row here, not five hundred.
   */
  *panel_activity(b, { limit = 30, offset = 0, action = null }) {
    const T = tableName(b, 'decision');
    const C = b.kind === 'pg' ? ' collate "C"' : '';
    const rows = yield [
      'all',
      `select plan_id, action, approved_via, count(*) as n,
              min(acted_at) as first_at, max(acted_at) as last_at,
              sum(case when undone_at is not null then 1 else 0 end) as undone,
              sum(case when already_listed = ? then 1 else 0 end) as already,
              min(did) as did, min(band) as band_low, max(band) as band_high
       from ${T}
       where acted_at is not null${action ? ' and action = ?' : ''}
       group by plan_id, action, approved_via
       order by max(acted_at)${C} desc, plan_id asc
       limit ? offset ?`,
      [bool(b, true), ...(action ? [action] : []), Number(limit), Number(offset)],
    ];
    return rows.map((r) => ({
      ...r,
      n: Number(r.n),
      undone: Number(r.undone),
      already: Number(r.already),
    }));
  },

  /** For each of these plans: how many accounts, added, still on, and read. */
  *panel_plan_counts(b, { ids = [] }) {
    if (!ids.length) return [];
    const rows = yield [
      'all',
      `select plan_id, count(*) as total,
              sum(case when action = 'list_add' and acted_at is not null then 1 else 0 end) as added,
              sum(case when action = 'list_add' and acted_at is not null and undone_at is null then 1 else 0 end) as live,
              sum(case when triage = 'hostile' then 1 else 0 end) as hostile,
              sum(case when triage = 'arguing' then 1 else 0 end) as arguing,
              sum(case when triage = 'neutral' then 1 else 0 end) as neutral,
              sum(case when evidence_uri is not null then 1 else 0 end) as with_text
       from ${tableName(b, 'decision')}
       where plan_id in (${ids.map(() => '?').join(',')})
       group by plan_id`,
      ids,
    ];
    return rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, k === 'plan_id' ? v : Number(v)]),
      ),
    );
  },

  /** How many accounts a re-score put in each band. */
  *panel_band_counts(b, { audit }) {
    const rows = yield [
      'all',
      `select band, count(*) as n from ${tableName(b, 'audit_item')}
       where audit_id = ? group by band`,
      [audit],
    ];
    return rows.map((r) => ({ band: r.band, n: Number(r.n) }));
  },

  /** Tokens per day, kind and model since `since`. */
  *panel_usage(b, { since }) {
    const C = b.kind === 'pg' ? ' collate "C"' : '';
    const rows = yield [
      'all',
      `select substr("at", 1, 10) as day, kind, model, count(*) as calls,
              sum(coalesce(input_tokens, 0)) as input_tokens,
              sum(coalesce(output_tokens, 0)) as output_tokens
       from ${tableName(b, 'llm_usage')}
       where "at"${C} >= ?
       group by substr("at", 1, 10), kind, model`,
      [since],
    ];
    return rows.map((r) => ({
      day: r.day,
      kind: r.kind,
      model: r.model,
      calls: Number(r.calls),
      input: Number(r.input_tokens),
      output: Number(r.output_tokens),
    }));
  },

  /** How many accounts are protected, by where the protection came from. */
  *panel_protected_counts(b) {
    const rows = yield [
      'all',
      `select source, reason, count(*) as n from ${tableName(b, 'protected')}
       group by source, reason`,
      [],
    ];
    return rows.map((r) => ({ source: r.source, reason: r.reason, n: Number(r.n) }));
  },
};

/** Call a named function, e.g. `rpc('finalise_snapshot', { snapshot })`. */
export async function rpc(fn, args = {}) {
  const f = FUNCTIONS[fn];
  if (!f) throw new Error(`db: no function ${fn}`);
  let b = ready();
  if (b.then) b = await b;
  return runSteps(b, f(b, args));
}
