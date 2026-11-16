import { describe, it, expect, vi } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { checkIntent, intentState, CHECK_PROMPT } from './tiers.js';

const input = {
  said: 'block the hostile ones',
  earlier: 'Plan 3f9a2c1b: 4 read as hostile.',
  action:
    'Add 4 accounts to the moderation list from plan 3f9a2c1b: every account on it that a triage labelled hostile.',
};

const says = (text) =>
  vi.fn(async () => ({ text, usage: { inputTokens: 500, outputTokens: 10 } }));

describe('the write check', () => {
  it('allows a yes, and keeps the reason', async () => {
    const out = await checkIntent(input, {
      generate: says('YES\nThe owner asked for the hostile ones.'),
      model: 'm/check',
    });
    expect(out).toMatchObject({
      allow: true,
      by: 'm/check',
      why: 'The owner asked for the hostile ones.',
    });
    expect(out.usage.map((u) => u.kind)).toEqual(['judge']);
  });

  it('refuses a no', async () => {
    const out = await checkIntent(input, {
      generate: says('NO\nwider than asked'),
      model: 'm/check',
    });
    expect(out.allow).toBe(false);
    expect(out.why).toBe('wider than asked');
  });

  it('refuses an answer it cannot read', async () => {
    const out = await checkIntent(input, {
      generate: says('Well, it depends.'),
      model: 'm/check',
    });
    expect(out.allow).toBe(false);
  });

  it('fails closed when the call fails', async () => {
    const out = await checkIntent(input, {
      generate: vi.fn().mockRejectedValue(new Error('503')),
      model: 'm/check',
    });
    expect(out).toMatchObject({ allow: false, by: 'none' });
  });

  it('fails closed when there is no model to ask', async () => {
    const generate = says('YES');
    const out = await checkIntent(input, { generate, model: null });
    expect(out.allow).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("puts the owner's words, the last reply and the change in the state, and nothing else", () => {
    const state = intentState(input);
    expect(state).toContain('The owner\'s latest message: "block the hostile ones"');
    expect(state).toContain("The assistant's previous message");
    expect(state).toContain('Proposed change: Add 4 accounts');
  });
});

// The fakes above agree with whatever shape they are handed. This runs the
// REAL generateText against a mock model, so a call shape the SDK rejects
// fails here and not on the first write of the day.
describe('the real SDK accepts the check', () => {
  it('sends the prompt and the state, and reads the answer back', async () => {
    let asked = null;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        asked = options;
        return {
          content: [{ type: 'text', text: 'YES\nasked for it' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 300, noCache: 300 },
            outputTokens: { total: 5, text: 5 },
          },
          warnings: [],
        };
      },
    });
    const out = await checkIntent(input, { generate: generateText, model });
    expect(out.allow).toBe(true);
    const sent = JSON.stringify(asked.prompt);
    expect(sent).toContain(CHECK_PROMPT.slice(0, 40));
    expect(sent).toContain('Proposed change');
  });
});
