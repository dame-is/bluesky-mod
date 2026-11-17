// The panel on invented data, with no Bluesky account and no network.
//
//   npm run panel:demo
//
// It opens a store in memory, fills it from scripts/panel-fixtures.js, and
// serves the real panel (src/panel/server.js) over it. Where the real bot
// would write to Bluesky, a stand-in below writes to the store instead, so
// buttons do what they say and nothing leaves this machine. The stand-in
// knows enough of each command to make the pages move; it is not the bot,
// and nothing about how the bot decides should be read from it.
//
// For working on the panel's pages, for screenshots, and for the panel's
// tests, which import demoDeps.

import { pathToFileURL } from 'node:url';

process.env.MOD_OWNER_DID ||= 'did:plc:owner0000000000000000000';
process.env.DATABASE_PATH ||= ':memory:';

const { select, selectAll, upsert, update, del } = await import('../src/bot/db.js');
const { findPlan, shortCode } = await import('../src/bot/bulkPlan.js');
const { isWrite, readOnlyReply, KINDS } = await import('../src/lib/command.js');
const { makeRoster } = await import('../src/lib/senders.js');
const { TargetError } = await import('../src/lib/target.js');
const { multiListOn, withListToken } = await import('../src/lib/listChoice.js');
const { resolveList } = await import('../src/bot/lists.js');
const { createPanel } = await import('../src/panel/server.js');
const { issueCode, formatCode } = await import('../src/panel/auth.js');
const fx = await import('./panel-fixtures.js');

const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** Where an invented account sits, by the ranges the fixtures deal from. */
function bandOf(i) {
  if (i <= 487) return 'PROTECTED';
  if (i >= 600 && i < 660) return 'CONNECTED';
  if (i >= 700 && i < 800) return 'PERIPHERAL';
  if (i >= 800 && i < 900) return 'NOTABLE';
  return 'UNKNOWN';
}

/** Adds still open, on one list when it is named. */
async function openAdds(where, { list = null, main = null } = {}) {
  const rows = await selectAll('decision', {
    select: 'plan_id,did,band,acted_at',
    eq: { action: 'list_add', ...where },
    where: { acted_at: 'not.is.null', undone_at: 'is.null' },
    order: 'did.asc',
  });
  if (!list) return rows;
  const bound = new Map(
    (await selectAll('plan', { select: 'id,list_uri', where: { list_uri: 'not.is.null' }, order: 'id.asc' })).map((p) => [p.id, p.list_uri]),
  );
  return rows.filter((r) => (bound.get(r.plan_id) || main) === list);
}

/**
 * What the panel borrows from a running bot, played by the store.
 *
 * @param {{ owner: string }} seeded  what seedDemo returned
 */
export function demoDeps(seeded) {
  let chain = Promise.resolve();
  let seq = 1_000_000;
  const startedAt = iso();

  const enqueue = (_label, job) => {
    const run = chain.then(job, job);
    chain = run.catch(() => {});
    return run;
  };

  // The lists: one, or three when the demo is run with MOD_MULTI_LIST=true.
  const everyList = fx.demoLists(seeded.bot);
  const main = everyList[0];
  const lists = () => (multiListOn() ? everyList : [{ ...main, name: 'the list' }]);
  const onList = (where, list) => openAdds(where, { list: list.uri, main: main.uri });
  const named = (list) => (multiListOn() ? list.name : 'the list');
  /** The bot's "Which list?": the same command once per list, each naming it. */
  const whichList = (text, among, commandsFor, { all = false } = {}) => ({
    text,
    outcome: null,
    options: [
      ...among.map((l) => ({ label: l.name, command: commandsFor(l)[0], commands: commandsFor(l) })),
      ...(all && among.length > 1 ? [{ label: 'Every list', command: commandsFor(among[0])[0], commands: among.flatMap(commandsFor) }] : []),
    ],
  });

  const logOne = async (did, action, raw, band, { already = false, list = main } = {}) => {
    const id = fx.demoId();
    const at = iso();
    await upsert('plan', [{ id, created_at: at, approved_at: at, approved_bands: ['command'], note: raw, ...(list.uri !== main.uri ? { list_uri: list.uri } : {}) }]);
    await upsert('decision', [{ plan_id: id, did, band, action, acted_at: at, acted_seq: (seq += 1), approved_via: 'command', ...(already ? { already_listed: true } : {}) }]);
  };

  async function runCommand(cmd, _agent, { canWrite = true } = {}) {
    const say = (text, outcome = null, options = null) => ({ text, outcome, options });
    if (!canWrite && isWrite(cmd)) return say(readOnlyReply(cmd));
    if (cmd.needsTarget) return say(cmd.refusal || 'Name who or what that is about.');

    if (cmd.action === 'list_add' || cmd.action === 'list_remove') {
      const i = fx.demoIndex(cmd.actor);
      if (i == null) return say(`I could not resolve ${cmd.actor}: no account found.`, 'failed');
      const did = fx.demoDid(i);
      const name = `@${fx.demoAccount(i).handle}`;
      const all = lists();
      const want = cmd.list ? resolveList(cmd.list, all, { allowAll: cmd.action === 'list_remove' }) : null;
      const token = (l) => (multiListOn() ? ` list:${l.rkey}` : '');
      if (cmd.action === 'list_add') {
        const ask = (lead) => whichList(`${lead}Which list for ${name}?`, all, (l) => [`list add ${did} list:${l.rkey}`]);
        if (want?.error) return ask(`${want.error} `);
        if (!want && all.length > 1) return ask('');
        const list = want?.list || all[0];
        const [veto] = await select('protected', { eq: { did } });
        if (veto) {
          return say(`${name} is PROTECTED (${veto.reason}). You follow them, or they are on one of your curation lists. No automated path acts on those, including this one. Do it in your client if you mean it.`);
        }
        if ((await onList({ did }, list)).length) {
          await logOne(did, 'list_add', cmd.raw, bandOf(i), { already: true, list });
          return say(`${name} was already on ${named(list)}.`, 'done');
        }
        await logOne(did, 'list_add', cmd.raw, bandOf(i), { list });
        return say(`Added ${name} to ${named(list)}.`, 'done', [{ label: 'Undo that', command: `list remove ${did}${token(list)}` }]);
      }
      // An unblock looks for them first: one list, that one; several, it asks.
      const on = [];
      for (const l of all) if ((await onList({ did }, l)).length) on.push(l);
      const off = (l) => [`list remove ${did} list:${l.rkey}`];
      if (want?.error) return whichList(`${want.error} Which should ${name} come off?`, all, off, { all: true });
      const from = want?.all ? on : want?.list ? [want.list] : on.length > 1 ? null : on;
      if (!from) return whichList(`${name} is on ${on.length} of your lists. Which should they come off?`, on, off, { all: true });
      if (!from.length) return say(multiListOn() ? `${name} is not on any of your lists.` : `${name} was not on the list.`);
      const lines = [];
      let changed = false;
      for (const l of from) {
        const open = await onList({ did }, l);
        if (!open.length) {
          lines.push(`${name} was not on ${named(l)}.`);
          continue;
        }
        await upsert('decision', open.map((o) => ({ plan_id: o.plan_id, did, band: o.band, action: 'list_add', acted_at: o.acted_at, undone_at: iso(), undo_reason: cmd.raw })));
        await logOne(did, 'list_remove', cmd.raw, bandOf(i), { list: l });
        lines.push(`Removed ${name} from ${named(l)}.`);
        changed = true;
      }
      return say(lines.join('\n'), changed ? 'done' : null);
    }

    const plan = await findPlan(cmd.code);
    if (!plan) return say(`No plan with code ${cmd.code}.`, 'failed');
    const code = shortCode(plan.id);
    const rows = await selectAll('decision', { eq: { plan_id: plan.id }, order: 'did.asc' });

    if (cmd.action === 'cancel') {
      await del('continuation', { eq: { plan_id: plan.id } });
      await update('plan', { eq: { id: plan.id } }, { note: `${plan.note || ''} (cancelled)` });
      const live = rows.filter((x) => x.action === 'list_add' && x.acted_at && !x.undone_at).length;
      return say(`Cancelled ${code}. ${live ? `${live} it added are still on the list; "undo ${code}" takes them off.` : 'Nothing was added.'}`, 'done');
    }

    if (cmd.action === 'undo') {
      const open = rows.filter((x) => x.action === 'list_add' && x.acted_at && !x.undone_at);
      if (!open.length) return say(`Nothing from plan ${code} is on the list.`);
      await del('continuation', { eq: { plan_id: plan.id } });
      await upsert('decision', open.map((o) => ({ plan_id: plan.id, did: o.did, band: o.band, action: 'list_add', acted_at: o.acted_at, undone_at: iso(), undo_reason: cmd.raw })));
      return say(`Took ${open.length.toLocaleString('en-US')} back off the list.`, 'done');
    }

    if (cmd.action === 'triage') {
      const unread = rows.filter((x) => x.evidence_uri && !x.triage);
      const counts = { hostile: 0, arguing: 0, neutral: 0 };
      await upsert('decision', unread.map((x, k) => {
        const label = k % 7 === 0 ? 'hostile' : k % 3 === 0 ? 'arguing' : 'neutral';
        counts[label] += 1;
        return { plan_id: plan.id, did: x.did, band: x.band, triage: label, triage_quote: { hostile: 'log off and never come back', arguing: 'Fix the rule, not the replies.', neutral: 'saving this for later' }[label], triage_at: iso(), triage_model: 'demo' };
      }));
      return say(`Read ${unread.length} of the ${rows.length} accounts on ${code}.\n\nHostile: ${counts.hostile}\nArguing: ${counts.arguing}\nNeutral: ${counts.neutral}`);
    }

    // approve. A plan goes to one list: the one an earlier approval bound it
    // to, or the one this approval names; with several lists and none named,
    // the bot asks.
    const all = lists();
    const boundUri = plan.list_uri || (plan.approved_at ? main.uri : null);
    let list = all.find((l) => l.uri === boundUri) || null;
    if (all.length > 1) {
      const want = cmd.list ? resolveList(cmd.list, all) : null;
      if (list && want && want.list?.uri !== list.uri) {
        return say(want.list ? `Plan ${code} adds to ${list.name}, so it cannot add to ${want.list.name} as well. Scan the post again and approve that scan to ${want.list.name}.` : `${want.error} Plan ${code} adds to ${list.name}; I changed nothing.`);
      }
      if (!list && !want?.list) {
        return whichList(`${want?.error ? `${want.error} ` : ''}Which list should plan ${code} add to?`, all, (l) => [withListToken(cmd.raw, l.rkey)]);
      }
      list ||= want.list;
    }
    list ||= all[0];
    const vetoed = new Set((await selectAll('protected', { select: 'did', order: 'did.asc' })).map((p) => p.did));
    const byName = new Set((cmd.actors || []).map((a) => fx.demoDid(fx.demoIndex(a))));
    const kinds = (cmd.kinds || []).flatMap((k) => KINDS[k] || []);
    const pending = rows.filter((x) => {
      if (x.acted_at || x.already_listed) return false;
      if (byName.size) return byName.has(x.did);
      if (cmd.bands?.length && !cmd.bands.includes(x.band)) return false;
      if (cmd.labels?.length && x.triage !== cmd.labels[0]) return false;
      if (kinds.length && !(x.engaged || []).some((e) => kinds.includes(e))) return false;
      return Boolean(cmd.bands?.length || cmd.labels?.length);
    });
    const held = pending.filter((x) => x.band === 'PROTECTED' || vetoed.has(x.did));
    const adding = pending.filter((x) => !held.includes(x));
    const via = byName.size ? 'individual' : cmd.labels?.length ? `triage:${cmd.labels[0]}` : 'band';
    const at = Date.now();
    await upsert('decision', adding.map((x, k) => ({ plan_id: plan.id, did: x.did, band: x.band, action: 'list_add', acted_at: iso(at + k), acted_seq: (seq += 1), approved_via: via })));
    if (adding.length) {
      const add = `; approved: ${cmd.raw}`;
      await update('plan', { eq: { id: plan.id } }, { approved_at: iso(at), note: String(plan.note || '').endsWith(add) ? plan.note : `${plan.note || ''}${add}`, ...(list.uri !== main.uri ? { list_uri: list.uri } : {}) });
    }
    const left = held.length ? ` ${held.length} PROTECTED were left out.` : '';
    return say(
      adding.length ? `Added ${adding.length.toLocaleString('en-US')} to ${named(list)}.${left}` : `Nothing to add.${left}`,
      adding.length ? 'done' : null,
      adding.length ? [{ label: `Undo all ${adding.length}`, command: `undo ${code}` }] : null,
    );
  }

  async function proposePlan({ link, kind }) {
    if (!/\/post\/|app\.bsky\.feed\.post/.test(link)) throw new TargetError('I scan posts, and that is not a post.');
    const id = fx.demoId();
    const base = 70000 + Math.floor(Math.random() * 20000);
    const rows = [
      ...[601, 602].map((i) => ({ i, band: 'CONNECTED' })),
      ...[701, 702, 703, 704, 705, 706].map((i) => ({ i, band: 'PERIPHERAL' })),
      { i: 801, band: 'NOTABLE' },
      ...Array.from({ length: 130 }, (_, k) => ({ i: base + k, band: 'UNKNOWN' })),
    ];
    const byBand = { PROTECTED: 0, CONNECTED: 2, PERIPHERAL: 6, NOTABLE: 1, UNKNOWN: 130 };
    const uri = `at://did:plc:demo000821/app.bsky.feed.post/3mdemo${base}`;
    await upsert('plan', [{ id, created_at: iso(), totals: { uri, kind, participants: rows.length, selected: rows.length, byBand, engagements: { like: 90, reply: 30, quote: 19 }, alreadyListed: 0, blocksYou: 0, truncated: false, unread: [] }, note: `bulk ${kind} from ${uri}` }]);
    await upsert('decision', rows.map(({ i, band }, k) => ({ plan_id: id, did: fx.demoDid(i), band, trust: band === 'UNKNOWN' ? 6 : 50, vouches: band === 'CONNECTED' ? 4 : band === 'PERIPHERAL' ? 1 : 0, engaged: [k % 5 === 0 ? 'quote' : k % 3 === 0 ? 'reply' : 'like'], evidence_uri: k % 5 === 0 || k % 3 === 0 ? `at://${fx.demoDid(i)}/app.bsky.feed.post/3x${k}` : null, already_listed: false, blocks_me: false })));
    return { code: shortCode(id) };
  }

  async function lookUp(actor) {
    const i = fx.demoIndex(actor);
    if (i == null) throw new Error('no account found');
    const a = fx.demoAccount(i);
    // Where the last re-score put them, so the demo agrees with itself.
    const [scored] = await select('audit_item', { select: 'band', eq: { did: a.did }, order: 'audit_id.desc', limit: 1 });
    const band = scored?.band || bandOf(i);
    return {
      ...a,
      missing: false,
      band,
      trust: band === 'PROTECTED' ? 100 : band === 'CONNECTED' ? 64 : band === 'PERIPHERAL' ? 40 : band === 'NOTABLE' ? 30 : 6,
      vouches: band === 'CONNECTED' ? 4 : band === 'PERIPHERAL' ? 1 : 0,
      ageDays: Math.round((Date.now() - Date.parse(a.createdAt)) / 86_400_000),
      youFollow: i <= 412,
      followsYou: i <= 300 || (i >= 600 && i < 620),
      protectedReason: i <= 412 || band === 'PROTECTED' && i > 487 ? 'you follow them' : i <= 484 ? 'on your list "Transit people"' : i <= 487 ? 'added by hand' : null,
      alreadyListed: (await openAdds({ did: a.did })).length > 0,
      blocksYou: false,
    };
  }

  const status = () => ({
    startedAt,
    now: iso(),
    queued: 0,
    dmAnswers: 212,
    errors: 0,
    lastPollAt: iso(Date.now() - 1200),
    lastDmAt: iso(Date.now() - 4 * 60_000),
    snapshotBusy: false,
    reference: 'held',
    bot: { did: seeded.bot, handle: 'quietlist.example.social' },
    owner: { did: seeded.owner, handle: 'rae.example.social' },
    list: main.uri,
    dryRun: false,
    dmMode: 'agent',
    scoring: 'full',
    provider: 'gateway',
    model: 'deepseek/deepseek-v4.1-flash',
    models: { agent: 'deepseek/deepseek-v4.1-flash', check: 'deepseek/deepseek-v4.1-flash', escalation: 'test/escalation' },
    jetstreamCursor: String((Date.now() - 3 * 3600_000) * 1000),
  });

  return {
    enqueue,
    writeAgent: () => ({ session: { did: seeded.bot } }),
    runCommand,
    proposePlan,
    lookUp,
    ownerConvo: async () => 'demo-convo',
    model: async () => 'deepseek/deepseek-v4.1-flash',
    generate: null,
    lists: async () => ({ multi: multiListOn(), lists: lists() }),
    async members(uri = main.uri) {
      const open = await openAdds({}, { list: uri, main: main.uri });
      return { dids: [...new Set(open.map((o) => o.did))], complete: true, at: Math.floor(Date.now() / 30_000) };
    },
    async profiles(dids) {
      const out = {};
      for (const did of dids) {
        if (did === seeded.owner) out[did] = { did, handle: 'rae.example.social', displayName: 'Rae', followers: 2140, posts: 8800 };
        const i = fx.demoIndex(did);
        if (i == null) continue;
        out[did] = i % 211 === 0 ? { did, missing: true } : { ...fx.demoAccount(i), avatar: fx.demoAvatar(i) };
      }
      return out;
    },
    async stopWatch(uri) {
      const [w] = await select('watch', { eq: { uri }, where: { stopped_at: 'is.null' }, limit: 1 });
      if (!w) return null;
      await update('watch', { eq: { id: w.id } }, { stopped_at: iso() });
      return w;
    },
    status,
    health: async () => ({
      ...status(),
      disk: { free: 612 * 1048576, total: 1024 * 1048576, low: false },
      database: { kind: 'SQLite', bytes: 288 * 1048576 },
      memory: { rss: 141 * 1048576, heap: 62 * 1048576 },
      intervals: { dmPollMs: 2000, driftEveryHours: 168, snapshotMaxAgeDays: 7, watchEveryMs: 300_000, alertEveryMs: 600_000 },
    }),
    settings: async (session) => ({
      mode: 'agent',
      scoring: 'full',
      dryRun: false,
      provider: 'gateway',
      atmosphere: true,
      database: 'SQLite',
      list: main.uri,
      multiList: multiListOn(),
      shield: { mode: 'ask', attack: 'ask', canGate: false, stream: true },
      keep: { snapshots: 2, audits: 4, unapprovedDays: 30, quotesDays: 0, usageDays: 90 },
      rescoreEveryHours: 168,
      snapshotMaxAgeDays: 7,
      watchEveryMs: 300_000,
      alertEveryMs: 600_000,
      panel: { url: null, sessionDays: 30 },
      file: { style: session.tier === 'owner' ? 'Short and plain. No exclamation marks.' : true, guidance: session.tier === 'owner' ? 'Ask before adding anyone with more than 5,000 followers.' : true, openers: false, report: false, postReport: false, model: null, limits: null, barePost: 'card' },
      notes: session.canWrite
        ? (await select('memory', { select: 'text,created_at,author_did', is: { removed_at: 'null' }, order: 'created_at.asc' })).map((n) => ({ text: n.text, at: n.created_at, byOwner: true }))
        : null,
    }),
    log: () => {},
  };
}

/** Seed a store and build the panel over it. */
export async function demoPanel({ port = 0, host = '127.0.0.1', extraRoster = {}, empty = false } = {}) {
  // `empty` leaves the store as a new install has it, to see every page
  // with nothing on it.
  const seeded = empty
    ? { owner: process.env.MOD_OWNER_DID, bot: 'did:plc:demobot00000000000000000', codes: {} }
    : await fx.seedDemo({ lists: multiListOn() });
  const roster = makeRoster({ owner: seeded.owner, ...extraRoster });
  const panel = createPanel({
    settings: { port, host, url: '', sessionDays: 30 },
    roster,
    deps: demoDeps(seeded),
  });
  return { panel, seeded, roster };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PANEL_PORT) || 8787;
  const guest = 'did:plc:demoguest000000000000000';
  const { panel, seeded } = await demoPanel({
    port,
    extraRoster: { allowed: [guest] },
    empty: process.env.PANEL_DEMO_EMPTY === '1',
  });
  await panel.listen();
  // The real bot sends a code by DM. Here they are printed, once each.
  const code = await issueCode(seeded.owner);
  const readOnly = await issueCode(guest);
  console.log(`The panel is at http://127.0.0.1:${port} on invented data. Nothing here touches Bluesky.`);
  console.log(`Sign-in code for the owner (once, ten minutes): ${formatCode(code)}`);
  console.log(`Sign-in code for a read-only guest: ${formatCode(readOnly)}`);
  console.log('For new codes, stop this and start it again.');
}
