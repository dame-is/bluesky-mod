import { describe, it, expect } from 'vitest';
import { compact, rows, stack, accountLine } from './stack.js';

describe('stacked replies', () => {
  it('shortens big numbers the way a phone reads them', () => {
    expect(compact(999)).toBe('999');
    expect(compact(6816)).toBe('6.8k');
    expect(compact(6000)).toBe('6k');
    expect(compact(52_400)).toBe('52k');
    expect(compact(1_234_567)).toBe('1.2m');
    expect(compact(null)).toBe('-');
  });

  it('leaves out empty rows and empty groups', () => {
    expect(rows([['likers', 3], ['reposters', 0], ['quoters', null]])).toBe(
      'likers: 3',
    );
    expect(stack('a', '', null, 'b')).toBe('a\n\nb');
  });

  it('sums an account up in one line', () => {
    expect(
      accountLine({
        band: 'CONNECTED',
        followers: 6816,
        alreadyListed: true,
      }),
    ).toBe('connected, 6.8k followers, on list');
  });
});
