import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadAgentConfig,
  parseConfig,
  clampLimits,
  resetAgentConfig,
  LIMITS,
} from './agentConfig.js';

const reading = (text) => () => {
  if (text instanceof Error) throw text;
  return text;
};
const missing = Object.assign(new Error('no file'), { code: 'ENOENT' });

beforeEach(() => resetAgentConfig());

describe('loadAgentConfig', () => {
  it('reads the file', async () => {
    const out = await loadAgentConfig({
      readFile: reading(JSON.stringify({ style: 'plain', guidance: 'be brief' })),
    });
    expect(out).toMatchObject({ style: 'plain', guidance: 'be brief' });
  });

  it('treats a missing file as no config, not an error', async () => {
    expect(await loadAgentConfig({ readFile: reading(missing) })).toBeNull();
  });

  it('keeps the last good copy when an edit breaks the JSON, and says so once', async () => {
    const logged = [];
    const log = (msg) => logged.push(msg);
    await loadAgentConfig({ readFile: reading('{"style":"plain"}'), log });
    const broken = reading('{"style": "plain",');
    expect(await loadAgentConfig({ readFile: broken, log })).toMatchObject({ style: 'plain' });
    await loadAgentConfig({ readFile: broken, log });
    expect(logged).toHaveLength(1);
  });

  it('keeps the last good copy when the file cannot be read, and says so', async () => {
    const logged = [];
    const log = (msg) => logged.push(msg);
    await loadAgentConfig({ readFile: reading('{"style":"plain"}'), log });
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(await loadAgentConfig({ readFile: reading(denied), log })).toMatchObject({
      style: 'plain',
    });
    expect(logged).toHaveLength(1);
  });

  it('returns null for a file with nothing in it worth applying', async () => {
    expect(await loadAgentConfig({ readFile: reading('{}') })).toBeNull();
  });
});

describe('parseConfig', () => {
  it('clips a field that is trying to be a second system prompt', () => {
    const out = parseConfig({ style: 'x'.repeat(5000), report: 'y'.repeat(5000) });
    expect(out.style).toHaveLength(2000);
    expect(out.report).toHaveLength(4000);
  });

  it('drops a malformed model rather than breaking every turn', () => {
    expect(parseConfig({ model: 'not a model; rm -rf' })?.model ?? '').toBe('');
    expect(parseConfig({ model: 'anthropic/claude-sonnet-5-5' }).model).toBe('anthropic/claude-sonnet-5-5');
    expect(parseConfig({ model: 'llama3.1:8b' }).model).toBe('llama3.1:8b');
  });

  it('only lets barePost be one of its two values', () => {
    expect(parseConfig({ barePost: 'author' }).barePost).toBe('author');
    expect(parseConfig({ style: 's', barePost: 'everyone' }).barePost).toBe('card');
  });
});

describe('clampLimits', () => {
  it('holds a runaway value to the range', () => {
    expect(clampLimits({ maxSteps: 400 }).maxSteps).toBe(LIMITS.maxSteps.max);
    expect(clampLimits({ maxTurns: -3 }).maxTurns).toBe(LIMITS.maxTurns.min);
  });

  it('falls back to the default for anything missing or unparseable', () => {
    expect(clampLimits({ maxSteps: 'lots' }).maxSteps).toBe(LIMITS.maxSteps.def);
    expect(clampLimits({}).reviewRows).toBe(LIMITS.reviewRows.def);
  });

  it('reads null, blank and true or false as missing, not as zero', () => {
    // Number(null), Number('') and Number(false) are all 0, which would clamp
    // maxSteps to one step and turn history off.
    expect(
      parseConfig({
        limits: { maxSteps: null, historyHours: null, maxTurns: '', reviewRows: false },
      }).limits,
    ).toEqual(clampLimits({}));
    expect(clampLimits({ maxTurns: '  ', maxSteps: true })).toMatchObject({
      maxTurns: LIMITS.maxTurns.def,
      maxSteps: LIMITS.maxSteps.def,
    });
    expect(clampLimits({ maxSteps: '6', historyHours: '0' })).toMatchObject({
      maxSteps: 6,
      historyHours: 0,
    });
  });

  it('allows zero history hours, which turns the window off', () => {
    expect(clampLimits({ historyHours: 0 }).historyHours).toBe(0);
  });
});
