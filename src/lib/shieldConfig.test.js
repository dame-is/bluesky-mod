import { describe, it, expect } from 'vitest';
import {
  parseRate,
  rateText,
  parseReplyRule,
  readShieldConfig,
} from './shieldConfig.js';

describe('parseRate', () => {
  it('reads a count over a window in minutes or hours', () => {
    expect(parseRate('12/15m')).toEqual({ count: 12, windowMs: 15 * 60_000 });
    expect(parseRate('40 / 30 min')).toEqual({ count: 40, windowMs: 30 * 60_000 });
    expect(parseRate('6/1h')).toEqual({ count: 6, windowMs: 60 * 60_000 });
    expect(parseRate('6/2hours')).toEqual({ count: 6, windowMs: 120 * 60_000 });
  });

  it('turns off for 0 or off, and falls back when unset', () => {
    expect(parseRate('0')).toBeNull();
    expect(parseRate('off')).toBeNull();
    const fallback = { count: 1, windowMs: 60_000 };
    expect(parseRate('', fallback)).toBe(fallback);
    expect(parseRate(undefined, fallback)).toBe(fallback);
  });

  it('refuses a typo rather than a trigger that never fires', () => {
    expect(() => parseRate('12')).toThrow(/not a threshold/);
    expect(() => parseRate('12/15s')).toThrow(/not a threshold/);
    expect(() => parseRate('0/15m')).toThrow(/above 0/);
    // Longer than the stream keeps, it could never fill.
    expect(() => parseRate('5/7h')).toThrow(/6 hours/);
  });

  it('writes a rate back the way it was typed', () => {
    expect(rateText(parseRate('12/15m'))).toBe('12/15m');
    expect(rateText(parseRate('6/2h'))).toBe('6/2h');
    expect(rateText(null)).toBe('off');
  });
});

describe('parseReplyRule', () => {
  it('reads who may still reply, in a fixed order', () => {
    expect(parseReplyRule('mentioned, following')).toEqual(['following', 'mentioned']);
    expect(parseReplyRule('followers and mentions')).toEqual(['followers', 'mentioned']);
    expect(parseReplyRule('no one')).toEqual(['nobody']);
  });

  it('defaults to people you follow and people you mention', () => {
    expect(parseReplyRule('')).toEqual(['following', 'mentioned']);
  });

  it('refuses unknown words, and nobody beside anyone', () => {
    expect(() => parseReplyRule('friends')).toThrow(/friends/);
    expect(() => parseReplyRule('nobody, followers')).toThrow(/nobody/);
  });
});

describe('readShieldConfig', () => {
  it('is off for triggers and asks for attack mode by default', () => {
    const { shield, problems } = readShieldConfig({});
    expect(problems).toEqual([]);
    expect(shield.mode).toBe('off');
    expect(shield.attack.mode).toBe('ask');
    expect(shield.canGate).toBe(false);
    expect(shield.replies).toEqual({ count: 12, windowMs: 15 * 60_000 });
    expect(shield.quotes).toEqual({ count: 6, windowMs: 15 * 60_000 });
    expect(shield.attack.trip).toEqual({ count: 40, windowMs: 30 * 60_000 });
    expect(shield.restoreHours).toBe(24);
    expect(shield.attack.hideReplies).toBe(false);
    expect(shield.attack.detachQuotes).toBe(true);
  });

  it('can gate once an app password for the owner is given', () => {
    const { shield, problems } = readShieldConfig({
      MOD_OWNER_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
      MOD_SHIELD: 'auto',
    });
    expect(problems).toEqual([]);
    expect(shield.canGate).toBe(true);
    expect(shield.mode).toBe('auto');
  });

  it('refuses an account password, or the bot\'s own app password', () => {
    const plain = readShieldConfig({ MOD_OWNER_APP_PASSWORD: 'hunter2' });
    expect(plain.shield.canGate).toBe(false);
    expect(plain.problems.join(' ')).toMatch(/never your account password/);
    const same = readShieldConfig({
      MOD_OWNER_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
      MOD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
    });
    expect(same.problems.join(' ')).toMatch(/same as MOD_APP_PASSWORD/);
  });

  it('reports every setting it cannot read', () => {
    const { problems } = readShieldConfig({
      MOD_SHIELD: 'sometimes',
      MOD_ATTACK_TRIP: 'lots',
      MOD_ATTACK_HOURS: '0',
      MOD_ATTACK_HIDE_REPLIES: 'maybe',
      MOD_SHIELD_REPLY_RULE: 'friends',
    });
    expect(problems).toHaveLength(5);
  });
});
