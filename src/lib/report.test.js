import { describe, it, expect } from 'vitest';
import {
  renderReport,
  sanitiseField,
  relationshipOf,
  listsOf,
  actionsFor,
  planActions,
  DEFAULT_REPORT_TEMPLATE,
  helpText,
} from './report.js';

const account = {
  did: 'did:plc:abc',
  handle: 'stranger.test',
  displayName: 'Sam (shop)',
  band: 'CONNECTED',
  trust: 62,
  distance: 1,
  vouches: 4,
  followers: 6305,
  follows: 900,
  posts: 70000,
  ageDays: 1024,
  postsPerDay: 68.3,
  mutual: false,
  youFollow: false,
  followsYou: false,
  protectedReason: null,
  alreadyListed: false,
};

describe('renderReport', () => {
  it('fills the form', () => {
    const out = renderReport(account);
    expect(out).toContain('Name: "Sam (shop)"');
    expect(out).toContain('Band: CONNECTED');
    expect(out).toContain('My Circle: 4');
    expect(out).toContain('Reach: 6,305 followers');
    expect(out).toContain('Age: 1,024 days');
    expect(out).toContain('Cadence: Posting ~68/day');
    expect(out).toContain('Lists: None');
    expect(out).toContain('Not mutual, not following, not followed');
  });

  it('takes a custom template', () => {
    expect(renderReport(account, { template: '{band}/{vouches}' })).toBe(
      'CONNECTED/4',
    );
  });

  it('leaves an unknown placeholder alone rather than blanking the line', () => {
    // A typo in the template should be visible, not silently delete a field.
    expect(renderReport(account, { template: 'x {nope} y' })).toBe(
      'x {nope} y',
    );
  });

  it('does not treat built-in object names as variables', () => {
    const template = '{constructor} {toString}';
    expect(renderReport(account, { template })).toBe(template);
  });

  it('uses the default template when the configured one is blank', () => {
    // A config file that sets only the voice leaves the template empty.
    expect(renderReport(account, { template: '' })).toBe(
      renderReport(account),
    );
  });

  it('is the same every time', () => {
    expect(renderReport(account)).toBe(renderReport(account));
  });
});

describe('sanitiseField', () => {
  it('will not let a display name forge a line of the report', () => {
    // The one dangerous value here: displayName is written by the
    // account being looked at, and a newline in it adds a row that reads
    // exactly like a field this code produced.
    const hostile = { ...account, displayName: 'nice\nBand: PROTECTED' };
    const out = renderReport(hostile);
    // The threat is a forged LINE. The text may still appear inside the quoted
    // name on the Name line, where it reads as what it is: someone's chosen
    // display name. What it must not do is start a row of its own.
    const bandLines = out.split('\n').filter((l) => l.startsWith('Band:'));
    expect(bandLines).toEqual(['Band: CONNECTED']);
    expect(out.split('\n')[0]).toContain('nice Band: PROTECTED');
  });

  it('strips format characters, not just newlines', () => {
    // A bidi override reorders a line without adding anything visible to it.
    expect(sanitiseField('a‮b')).toBe('a b');
    expect(sanitiseField('a​b')).toBe('a b');
  });

  it('caps a name long enough to push the real fields out of view', () => {
    expect(sanitiseField('x'.repeat(500)).length).toBeLessThanOrEqual(64);
  });

  it('never cuts a surrogate pair in half when it caps', () => {
    const out = sanitiseField('😀'.repeat(100));
    expect(out).toBe(`${'😀'.repeat(63)}…`);
  });

  it('shows a dash for nothing at all', () => {
    expect(sanitiseField('')).toBe('-');
    expect(sanitiseField(null)).toBe('-');
    expect(sanitiseField('   ')).toBe('-');
  });
});

describe('relationshipOf', () => {
  it('reads the booleans in priority order', () => {
    expect(relationshipOf({ mutual: true, youFollow: true })).toBe('Mutual');
    expect(relationshipOf({ youFollow: true })).toBe('You follow them');
    expect(relationshipOf({ followsYou: true })).toBe('They follow you');
    expect(relationshipOf({})).toBe('Not mutual, not following, not followed');
  });
});

describe('listsOf', () => {
  it('names why they are spared as well as where they are listed', () => {
    expect(listsOf({ alreadyListed: true })).toBe('moderation list');
    expect(listsOf({ protectedReason: 'list:Friends' })).toContain(
      'PROTECTED',
    );
    expect(listsOf({})).toBe('None');
  });
});

describe('actionsFor', () => {
  it('offers add, remove, and a way to look before acting', () => {
    const out = actionsFor(account);
    expect(out.map((o) => o.command)).toEqual([
      'list add @stranger.test',
      'list remove @stranger.test',
      'read @stranger.test',
    ]);
  });

  it('names an account by DID when it has no usable handle', () => {
    // The command parser takes a bare DID, not one after an @.
    for (const handle of [null, 'handle.invalid']) {
      const out = actionsFor({ ...account, handle });
      expect(out.map((o) => o.command)).toEqual([
        'list add did:plc:abc',
        'list remove did:plc:abc',
        'read did:plc:abc',
      ]);
    }
  });

  it('offers no add for a PROTECTED account', () => {
    // The write would refuse it, and a button that exists to be rejected is
    // worse than no button. Reading them is still fine: it changes nothing.
    const out = actionsFor({ ...account, protectedReason: 'list:Friends' });
    expect(out.map((o) => o.command)).toEqual([
      'list remove @stranger.test',
      'read @stranger.test',
    ]);
  });
});

describe('planActions', () => {
  const plan = {
    code: 'afe16c3f',
    total: 0,
    byBand: {},
    author: { did: 'did:plc:xyz', handle: 'author.test', band: 'UNKNOWN' },
  };

  it('offers the author when a post has no engagement at all', () => {
    // Every band is zero, so without the author the only option would be "Do
    // nothing": true about the graph around the post and useless about the
    // account that wrote it.
    const out = planActions(plan);
    expect(out.map((o) => o.command)).toEqual([
      'list add @author.test',
      'read @author.test',
      'cancel afe16c3f',
    ]);
  });

  it('will not offer to add a PROTECTED author', () => {
    const out = planActions({
      ...plan,
      author: { ...plan.author, band: 'PROTECTED', protectedReason: 'follows' },
    });
    expect(out.map((o) => o.command)).not.toContain('list add @author.test');
    expect(out.map((o) => o.command)).toContain('read @author.test');
  });

  it('still leads with the author when there is engagement to approve', () => {
    const out = planActions({
      ...plan,
      total: 48,
      byBand: { UNKNOWN: 43, CONNECTED: 5 },
    });
    expect(out[0].command).toBe('list add @author.test');
    expect(out.map((o) => o.command)).toContain('approve afe16c3f UNKNOWN');
  });

  it('says nothing about an author it could not score', () => {
    const out = planActions({ ...plan, author: null });
    expect(out.map((o) => o.command)).toEqual(['cancel afe16c3f']);
  });

  it('offers no reading when there is no model to read with', () => {
    // Pressing it would only get "I only understand commands" back.
    const withText = { ...plan, total: 3, withText: 3, byBand: { UNKNOWN: 3 } };
    expect(planActions(withText).map((o) => o.command.split(' ')[0])).toContain(
      'triage',
    );
    const out = planActions(withText, { hasModel: false });
    expect(out.map((o) => o.command)).toEqual([
      'list add @author.test',
      'approve afe16c3f UNKNOWN',
      'cancel afe16c3f',
    ]);
    expect(
      actionsFor(account, { hasModel: false }).map((o) => o.command),
    ).toEqual(['list add @stranger.test', 'list remove @stranger.test']);
  });
});

describe('the default template', () => {
  it('uses only variables that exist', () => {
    const rendered = renderReport(account, {
      template: DEFAULT_REPORT_TEMPLATE,
    });
    expect(rendered).not.toMatch(/\{\w+\}/);
  });
});

describe('the post scan', () => {
  const plan = {
    code: '3f9a2c1b',
    uri: 'at://did:plc:abc/app.bsky.feed.post/3xyz',
    kind: 'everyone',
    total: 15,
    byBand: {
      PROTECTED: 0,
      CONNECTED: 0,
      PERIPHERAL: 2,
      NOTABLE: 0,
      UNKNOWN: 13,
    },
    engagements: { like: 15, repost: 1 },
    truncated: false,
  };

  it('renders the same form every time', async () => {
    const { renderPlanReport } = await import('./report.js');
    const out = renderPlanReport(plan);
    expect(out).toContain('Participants: 15');
    expect(out).toContain('15 like, 1 repost');
    expect(out).toContain('UNKNOWN: 13');
    expect(out).toContain('PERIPHERAL: 2');
    expect(out).toContain('Need a look: 2 PERIPHERAL');
    expect(out).toContain('Plan: 3f9a2c1b');
    expect(renderPlanReport(plan)).toBe(out);
  });

  it('offers only bands that have somebody in them', async () => {
    // An approval carrying zero accounts is a button that does nothing, and a
    // menu of those teaches you to stop reading the menu.
    const { planActions } = await import('./report.js');
    const out = planActions(plan);
    expect(out.map((o) => o.label)).toEqual([
      'Add the 13 UNKNOWN accounts',
      'Show me the 2 that need a look',
      'Add all 15, every band',
      'Do nothing',
    ]);
    expect(out[0].command).toBe('approve 3f9a2c1b UNKNOWN');
  });

  it('drops the review option when everything is UNKNOWN', async () => {
    const { planActions } = await import('./report.js');
    const flat = { ...plan, byBand: { UNKNOWN: 4 }, total: 4 };
    expect(planActions(flat).map((o) => o.label)).toEqual([
      'Add the 4 UNKNOWN accounts',
      'Do nothing',
    ]);
  });

  it('never offers to carry PROTECTED', async () => {
    const { planActions } = await import('./report.js');
    const withProtected = {
      ...plan,
      byBand: { PROTECTED: 3, UNKNOWN: 5, CONNECTED: 2 },
      total: 10,
    };
    for (const o of planActions(withProtected)) {
      expect(o.command).not.toContain('PROTECTED');
    }
  });

  it('counts an add by who it could still add, not who is already listed', async () => {
    // A second scan of the same post: most engagers went on the list the
    // first time, and the write skips them. "Add the 300" that adds 10 is a
    // label promising what the button does not do.
    const { planActions } = await import('./report.js');
    const rescan = {
      ...plan,
      total: 310,
      byBand: {
        PROTECTED: 1,
        CONNECTED: 4,
        PERIPHERAL: 5,
        NOTABLE: 0,
        UNKNOWN: 300,
      },
      fresh: {
        total: 12,
        byBand: {
          PROTECTED: 0,
          CONNECTED: 0,
          PERIPHERAL: 2,
          NOTABLE: 0,
          UNKNOWN: 10,
        },
        likers: 12,
      },
    };
    const out = planActions(rescan);
    expect(out.map((o) => o.label)).toEqual([
      'Add the 10 UNKNOWN accounts',
      'Show me the 9 that need a look',
      'Add all 12, every band',
      'Do nothing',
    ]);
    expect(out[2].command).toBe('approve 3f9a2c1b PERIPHERAL,UNKNOWN');
  });

  it('offers no add when everyone is already on the list', async () => {
    const { planActions } = await import('./report.js');
    const listed = {
      ...plan,
      total: 7,
      byBand: { CONNECTED: 2, UNKNOWN: 5 },
      fresh: { total: 0, byBand: { CONNECTED: 0, UNKNOWN: 0 }, likers: 0 },
    };
    expect(planActions(listed).map((o) => o.command)).toEqual([
      'review 3f9a2c1b',
      'cancel 3f9a2c1b',
    ]);
  });

  it('says when the harvest was cut short', async () => {
    // A viral post stops at the page cap. Without a line saying so, "UNKNOWN:
    // 5,800" reads as everyone who engaged.
    const { renderPlanReport } = await import('./report.js');
    expect(renderPlanReport(plan)).not.toMatch(/cut short/i);
    const cut = renderPlanReport({ ...plan, truncated: true });
    expect(cut).toMatch(/^Cut short: .*part of the post\.$/m);
    // A template that places {truncated} itself gets no second line.
    const own = renderPlanReport(
      { ...plan, truncated: true },
      { template: 'Plan {code}. Cut: {truncated}' },
    );
    expect(own).toMatch(/^Plan 3f9a2c1b\. Cut: yes, /);
    expect(own.split('\n')).toHaveLength(1);
  });
});

describe('estimateWrites', () => {
  it('quotes the ceiling that actually binds', async () => {
    // A create is 3 points against 5,000/hour, and also one repo event against
    // the relay's 2,600/hour for the whole PDS. For big batches the relay is
    // the tighter limit.
    const { estimateWrites } = await import('../bot/bulkPlan.js');
    expect(estimateWrites(0)).toBe('nothing to write');
    expect(estimateWrites(10)).toContain('30 points');
    expect(estimateWrites(10)).toContain('under a minute');
    const big = estimateWrites(8000);
    expect(big).toContain('24,000 points');
    expect(big).toMatch(/hours/);
  });

  it('costs a delete at one point, not three', async () => {
    const { estimateWrites } = await import('../bot/bulkPlan.js');
    expect(estimateWrites(100, { kind: 'delete' })).toContain('100 points');
  });
});

describe('helpText', () => {
  it('leads with the thing that has no other way in', () => {
    // A lookup is found by typing a handle and a scan by pasting a link.
    // Nothing leads anyone to a digest except being told.
    const text = helpText();
    expect(text.indexOf('WHAT THE NETWORK IS SAYING')).toBeLessThan(
      text.indexOf('ONE ACCOUNT'),
    );
    expect(text).toContain('pulse');
    expect(text).toContain('what are the people I follow talking about');
  });

  it('leaves writes out for a read-only sender rather than listing them', () => {
    // The rule the menus follow. A menu of buttons that reject you teaches you
    // to stop reading the menu.
    const ro = helpText({ canWrite: false });
    for (const verb of ['block ', 'approve ', 'undo', 'add likers']) {
      expect(ro).not.toContain(verb);
    }
    expect(ro).toContain('pulse');
    expect(ro).toContain('read @handle');

    const rw = helpText({ canWrite: true });
    expect(rw).toContain('block @handle');
    expect(rw).toContain('approve <code> UNKNOWN');
  });

  it('leaves out what needs a model when there is none', () => {
    const text = helpText({ hasModel: false });
    for (const verb of ['pulse', 'thread', 'read @handle']) {
      expect(text).not.toContain(verb);
    }
    expect(text).toContain('history @handle');
    expect(text).toContain('block @handle');
  });

  it('says undo takes back the last add, whatever its size', () => {
    // Bare undo picks the most recent addition still on the list, which after
    // a "block @x" is that one account and not the batch before it.
    const line = helpText()
      .split('\n')
      .find((l) => /^\s+undo\s/.test(l));
    expect(line).toMatch(/last add/);
    expect(line).not.toMatch(/last batch/);
  });
});
