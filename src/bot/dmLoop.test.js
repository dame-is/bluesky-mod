import { describe, it, expect, vi, afterEach } from 'vitest';

// Whether a model is set up, as models.js would report it.
const models = vi.hoisted(() => ({ on: true }));
vi.mock('../models.js', async (importOriginal) => ({
  ...(await importOriginal()),
  modelsEnabled: () => models.on,
}));

import {
  sharedPostUri,
  composeMessage,
  runCommand,
  routeFor,
  normaliseMode,
  plainText,
} from './dmLoop.js';
import { parseCommand } from '../lib/command.js';
import { NUDGE } from '../lib/phrases.js';

describe('a post shared into a DM', () => {
  // Sharing from the Bluesky app puts no link in the text: the post travels in
  // embed.record.uri.
  const embed = (uri) => ({ record: { uri, cid: 'bafy' } });

  it('finds the uri in the embed', () => {
    const uri = 'at://did:plc:abc/app.bsky.feed.post/3xyz';
    expect(sharedPostUri({ text: 'check this', embed: embed(uri) })).toBe(uri);
  });

  it('ignores an embed that is not a record', () => {
    expect(sharedPostUri({ text: 'x' })).toBe(null);
    expect(sharedPostUri({ text: 'x', embed: {} })).toBe(null);
    expect(
      sharedPostUri({
        text: 'x',
        embed: { record: { uri: 'https://ex.com' } },
      }),
    ).toBe(null);
    expect(sharedPostUri(null)).toBe(null);
  });

  it('is not a post when it is a list, a starter pack or a feed', () => {
    for (const uri of [
      'at://did:plc:abc/app.bsky.graph.list/3list',
      'at://did:plc:abc/app.bsky.graph.starterpack/3pack',
      'at://did:plc:abc/app.bsky.feed.generator/hot',
    ]) {
      expect(sharedPostUri({ text: '', embed: embed(uri) })).toBe(null);
    }
  });

  it('still shows the model a shared record that is not a post', () => {
    const uri = 'at://did:plc:abc/app.bsky.graph.list/3list';
    const out = composeMessage({ text: 'what is this', embed: embed(uri) });
    expect(out).toContain(uri);
    expect(out).not.toContain('The post the owner shared');
  });

  it('hands the model the text and the shared post together', () => {
    const uri = 'at://did:plc:abc/app.bsky.feed.post/3xyz';
    const out = composeMessage({ text: 'who liked this', embed: embed(uri) });
    expect(out).toContain('who liked this');
    expect(out).toContain(uri);
  });

  it('leaves a plain message alone', () => {
    expect(composeMessage({ text: 'hello' })).toBe('hello');
  });
});

describe('composeMessage with facets', () => {
  it('hands the model the full link, not the truncated text', () => {
    const out = composeMessage({
      text: 'can you add this user to the block list bsky.app/profile/stra...',
      facets: [
        {
          features: [
            {
              $type: 'app.bsky.richtext.facet#link',
              uri: 'https://bsky.app/profile/stranger.test',
            },
          ],
        },
      ],
    });
    expect(out).toContain('https://bsky.app/profile/stranger.test');
  });

  it('does not repeat a link that was already written out in full', () => {
    const url = 'https://bsky.app/profile/a.bsky.social';
    const out = composeMessage({
      text: `check ${url}`,
      facets: [
        { features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] },
      ],
    });
    expect(out).toBe(`check ${url}`);
  });

  it('surfaces mentioned accounts as DIDs', () => {
    const out = composeMessage({
      text: '@someone',
      facets: [
        {
          features: [
            { $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:abc' },
          ],
        },
      ],
    });
    expect(out).toContain('did:plc:abc');
  });
});

describe('help', () => {
  const cmd = { action: 'help', needsTarget: false, raw: 'help' };

  it('answers with no session at all', async () => {
    // Help returns before the writeAgent guard on purpose: asking what the
    // bot does should work when nothing else does.
    const out = await runCommand(cmd, null, { canWrite: true });
    expect(out.text).toContain('WHAT THE NETWORK IS SAYING');
    expect(out.text).toContain('pulse');
  });

  it('offers the digest as a pressable first move', async () => {
    const out = await runCommand(cmd, null, { canWrite: true });
    expect(out.options).toHaveLength(1);
    expect(out.options[0].command).toBe('pulse');
    // Derived from the parse, like every other option in this system.
    expect(out.options[0].label).toMatch(/your circle/i);
  });

  it('shows a read-only sender only what they can actually run', async () => {
    const out = await runCommand(cmd, null, { canWrite: false });
    expect(out.text).not.toContain('block @handle');
    expect(out.text).not.toContain('approve ');
    expect(out.text).toContain('pulse');
  });
});

describe('a verb with no plan code', () => {
  for (const verb of ['approve', 'cancel', 'review', 'triage']) {
    it(`asks for the code on a bare "${verb}"`, async () => {
      const out = await runCommand(parseCommand(verb), null, {
        canWrite: true,
      });
      expect(NUDGE.plan).toContain(out.text);
    });
  }
});

describe('with no model set up', () => {
  afterEach(() => {
    models.on = true;
  });

  it('says sorting by tone needs a model, before looking for the plan', async () => {
    models.on = false;
    const out = await runCommand(parseCommand('triage 1c2d3e4f'), {}, {
      canWrite: true,
      model: 'some/model',
    });
    expect(out.text).toBe(
      'Sorting by tone needs an AI model, and this bot has none set up.',
    );
  });

  it('offers no reading in the menu that asks about a post', async () => {
    const cmd = parseCommand('block whoever is in the replies', {
      embedUri: 'at://did:plc:author/app.bsky.feed.post/3abc',
    });
    const lookUp = async (did) => ({
      did,
      handle: 'poster.test',
      band: 'UNKNOWN',
    });
    const withModel = await runCommand(cmd, {}, { canWrite: true, lookUp });
    expect(withModel.options.map((o) => o.command)).toEqual([
      'list add did:plc:author',
      'read @poster.test',
    ]);
    models.on = false;
    const without = await runCommand(cmd, {}, { canWrite: true, lookUp });
    expect(without.options.map((o) => o.command)).toEqual([
      'list add did:plc:author',
    ]);
  });
});

describe('an approval the parser refused', () => {
  it('says which word it could not place, and adds nobody', async () => {
    const write = { com: { atproto: { repo: {} } } };
    const out = await runCommand(
      parseCommand('approve 1c2d3e4f hostile except @friend.test'),
      write,
      { canWrite: true },
    );
    expect(out.text).toBe(
      parseCommand('approve 1c2d3e4f hostile except @friend.test').refusal,
    );
    expect(out.text).toMatch(/"except"/);
    expect(out.options).toBe(null);
  });
});

describe('agent mode routing', () => {
  it('is classic unless asked for by name', () => {
    expect(normaliseMode(undefined)).toBe('classic');
    expect(normaliseMode('')).toBe('classic');
    expect(normaliseMode('agnet')).toBe('classic');
    expect(normaliseMode(' Agent ')).toBe('agent');
  });

  it('changes nothing in classic mode, "!" included', () => {
    expect(routeFor('block @a.test')).toEqual({
      route: 'classic',
      text: 'block @a.test',
    });
    expect(routeFor('!block @a.test')).toEqual({
      route: 'classic',
      text: '!block @a.test',
    });
  });

  it('sends words to the agent', () => {
    expect(
      routeFor('block the nasty ones in the quotes', { mode: 'agent' }).route,
    ).toBe('agent');
    // A typed command is words too, in this mode. "!" is how to insist.
    expect(routeFor('block @a.test', { mode: 'agent' }).route).toBe('agent');
  });

  it('takes "!" as the classic path for one message', () => {
    expect(routeFor('!block @a.test', { mode: 'agent' })).toEqual({
      route: 'classic',
      text: 'block @a.test',
    });
    expect(routeFor('  ! help', { mode: 'agent' })).toEqual({
      route: 'classic',
      text: 'help',
    });
  });

  it('reads "!!!" as a feeling, not a prefix', () => {
    expect(routeFor('!!! these people', { mode: 'agent' }).route).toBe('agent');
    expect(routeFor('!', { mode: 'agent' }).route).toBe('agent');
  });

  it('holds a bare number for the menu check', () => {
    expect(routeFor('2', { mode: 'agent' }).route).toBe('choice');
  });
});

describe('agent replies in a DM', () => {
  it('drops markdown emphasis and headings, which a DM shows raw', () => {
    expect(plainText('## Vibe\n- **Main theme:** mockery')).toBe(
      'Vibe\n- Main theme: mockery',
    );
  });

  it('leaves everything else alone', () => {
    expect(plainText('2 * 3 = 6, and a_b stays')).toBe(
      '2 * 3 = 6, and a_b stays',
    );
  });

  it('sends "^" to the escalation model, and a lone "^" to the agent model', () => {
    expect(routeFor('^ what is the vibe here', { mode: 'agent' })).toEqual({
      route: 'agent',
      escalate: true,
      text: 'what is the vibe here',
    });
    expect(routeFor('^', { mode: 'agent' })).toEqual({
      route: 'agent',
      text: '^',
    });
    expect(routeFor('^ what is the vibe here')).toEqual({
      route: 'classic',
      text: '^ what is the vibe here',
    });
  });
});
