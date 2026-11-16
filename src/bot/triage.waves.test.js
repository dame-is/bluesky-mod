// The triage cascade, against an in-memory decision table and a stubbed
// AppView: which posts the second wave reads, whose label is kept, and what
// happens when the second wave cannot answer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = { decision: [], usage: [] };

vi.mock('./db.js', () => ({
  select: vi.fn(async () => []),
  selectAll: vi.fn(async (table, opts = {}) => {
    const rows = table === 'decision' ? db.decision : [];
    const eq = opts.eq || {};
    return rows.filter((r) => Object.entries(eq).every(([k, v]) => r[k] === v));
  }),
  update: vi.fn(async () => {}),
  upsert: vi.fn(async (table, rows) => {
    if (table === 'llm_usage') db.usage.push(...rows);
    if (table !== 'decision') return rows.length;
    for (const row of rows) {
      const i = db.decision.findIndex(
        (r) => r.plan_id === row.plan_id && r.did === row.did,
      );
      if (i === -1) db.decision.push({ ...row });
      else db.decision[i] = { ...db.decision[i], ...row };
    }
    return rows.length;
  }),
}));

const { runTriage, reviewTriage } = await import('./triage.js');

const PLAN = { id: 'plan-1' };
const POSTS = {
  'at://did:plc:p1/app.bsky.feed.post/1': 'you are a worthless idiot',
  'at://did:plc:p2/app.bsky.feed.post/2': 'this policy is cowardly',
  'at://did:plc:p3/app.bsky.feed.post/3': 'lol nice',
  'at://did:plc:p4/app.bsky.feed.post/4': 'pile on this clown',
};

/** A labeller that answers by keyword, standing in for a model. */
function labeller(map) {
  return vi.fn(async ({ messages, model }) => {
    const items = messages[0].content.split(/\n(?=\d+\. )/);
    const text = items
      .map((item, i) => {
        const hit = Object.entries(map).find(([k]) => item.includes(k));
        return `${i + 1}: ${hit ? hit[1] : 'neutral'}`;
      })
      .join('\n');
    return { text, usage: { inputTokens: 100, outputTokens: 10 }, model };
  });
}

beforeEach(() => {
  db.decision = Object.keys(POSTS).map((uri, i) => ({
    plan_id: PLAN.id,
    did: `did:plc:p${i + 1}`,
    band: 'UNKNOWN',
    evidence_uri: uri,
    triage: null,
  }));
  db.usage = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const uris = [...new URL(url).searchParams.getAll('uris')];
      return {
        ok: true,
        json: async () => ({
          posts: uris.map((uri) => ({ uri, record: { text: POSTS[uri] } })),
        }),
      };
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const label = (did) => db.decision.find((r) => r.did === did);

describe('triage in two waves', () => {
  it("re-reads what the first wave calls hostile, and keeps the second model's label", async () => {
    // First wave: calls the idiot post AND the policy post hostile.
    // Second wave: agrees about the idiot, not the policy post.
    const generate = vi.fn(async (opts) =>
      opts.model === 'strong/model'
        ? labeller({ idiot: 'hostile', cowardly: 'arguing', clown: 'hostile' })(
            opts,
          )
        : labeller({ idiot: 'hostile', cowardly: 'hostile', clown: 'arguing' })(
            opts,
          ),
    );
    const out = await runTriage(PLAN, {
      generate,
      model: 'cheap/model',
      escalation: 'strong/model',
    });

    expect(label('did:plc:p1')).toMatchObject({
      triage: 'hostile',
      triage_model: 'strong/model',
    });
    expect(label('did:plc:p2')).toMatchObject({
      triage: 'arguing',
      triage_model: 'strong/model',
    });
    // Not flagged by the first wave, so its label stands and nobody re-reads it.
    expect(label('did:plc:p4')).toMatchObject({
      triage: 'arguing',
      triage_model: 'cheap/model',
    });
    expect(label('did:plc:p3')).toMatchObject({
      triage: 'neutral',
      triage_model: 'cheap/model',
    });
    expect(out.secondWave).toMatchObject({
      model: 'strong/model',
      read: 2,
      overturned: 1,
    });
    expect(out.counts.hostile).toBe(1);
    expect(db.usage.map((u) => u.kind).sort()).toEqual([
      'triage',
      'triage-escalated',
    ]);
  });

  it('leaves a flagged post unlabelled when the second wave cannot read it', async () => {
    const generate = vi.fn(async (opts) => {
      if (opts.model === 'strong/model') throw new Error('503');
      return labeller({ idiot: 'hostile' })(opts);
    });
    const out = await runTriage(PLAN, {
      generate,
      model: 'cheap/model',
      escalation: 'strong/model',
    });
    // The one post that would have been "hostile" is exactly the one not
    // trusted to the first wave alone, so it stays pending for next time.
    expect(label('did:plc:p1').triage).toBe(null);
    expect(label('did:plc:p2').triage).toBe('neutral');
    expect(out.remaining).toBe(1);
    expect(out.counts.hostile).toBe(0);
    expect(out.secondWave).toMatchObject({ read: 0, failed: 1 });
  });

  it('counts a flagged post the second wave answered without labelling as not read', async () => {
    const generate = vi.fn(async (opts) => {
      if (opts.model === 'strong/model') {
        return { text: 'I would rather not say.', usage: {} };
      }
      return labeller({ idiot: 'hostile' })(opts);
    });
    const out = await runTriage(PLAN, {
      generate,
      model: 'cheap/model',
      escalation: 'strong/model',
    });
    expect(label('did:plc:p1').triage).toBe(null);
    expect(out.secondWave).toMatchObject({ read: 0, overturned: 0, failed: 1 });
  });

  it('is a single pass when there is no second model', async () => {
    const generate = labeller({ idiot: 'hostile' });
    const out = await runTriage(PLAN, {
      generate,
      model: 'cheap/model',
      escalation: 'off',
    });
    expect(label('did:plc:p1')).toMatchObject({
      triage: 'hostile',
      triage_model: 'cheap/model',
    });
    expect(out.secondWave).toBeUndefined();
  });
});

describe('what is left to add', () => {
  it('counts only the rows approving the label would actually add', async () => {
    const hostile = (did, extra = {}) => ({
      plan_id: PLAN.id,
      did,
      band: 'UNKNOWN',
      evidence_uri: `at://${did}/app.bsky.feed.post/1`,
      triage: 'hostile',
      triage_quote: 'pile on',
      ...extra,
    });
    db.decision = [
      hostile('did:plc:fresh'),
      hostile('did:plc:friend', { band: 'PROTECTED' }),
      hostile('did:plc:listed', { already_listed: true }),
      hostile('did:plc:added', { acted_at: '2026-10-01T10:00:00Z' }),
      hostile('did:plc:undone', {
        acted_at: '2026-10-01T10:00:00Z',
        undone_at: '2026-10-01T11:00:00Z',
      }),
    ];
    const out = await runTriage(PLAN, { generate: vi.fn(), model: 'm' });
    expect(out.counts.hostile).toBe(5);
    expect(out.pending.hostile).toBe(1);

    const review = await reviewTriage(PLAN, 'hostile');
    expect(review).toMatchObject({ total: 5, pending: 1, added: 1 });
    expect(review.rows.map((r) => r.did)).toEqual(['did:plc:fresh']);
  });
});
