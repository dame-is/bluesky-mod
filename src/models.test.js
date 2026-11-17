import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateText } from 'ai';
import * as models from './models.js';
import {
  createProvider,
  installProvider,
  modelIds,
  modelProblems,
} from './models.js';

/**
 * A fetch that records each request and answers 401, so a model call fails
 * without anything leaving the machine.
 */
function recordingFetch() {
  const seen = [];
  const impl = vi.fn(async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response('{"error":{"message":"no"}}', {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  impl.seen = seen;
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.AI_SDK_DEFAULT_PROVIDER;
});

describe('where each key is sent', () => {
  it('sends the OpenRouter key to OpenRouter, whatever MODEL_BASE_URL says', async () => {
    // MODEL_BASE_URL belongs to openai-compatible. Left over from trying
    // another server, it must not redirect the OpenRouter key there.
    const fetch = recordingFetch();
    vi.stubGlobal('fetch', fetch);
    const provider = createProvider('openrouter', {
      OPENROUTER_API_KEY: 'sk-or-test',
      MODEL_BASE_URL: 'https://api.groq.com/openai/v1',
    });
    await generateText({
      model: provider.languageModel('deepseek/deepseek-v4.1-flash'),
      prompt: 'x',
      maxRetries: 0,
    }).catch(() => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(fetch.seen[0].url).host).toBe('openrouter.ai');
  });

  it('does not send MODEL_API_KEY to Anthropic, OpenAI or OpenRouter', () => {
    for (const [provider, key] of [
      ['anthropic', 'ANTHROPIC_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
      ['openrouter', 'OPENROUTER_API_KEY'],
    ]) {
      const problems = modelProblems({
        MODEL_PROVIDER: provider,
        MODEL_API_KEY: 'key-for-a-local-server',
        MOD_AGENT_MODEL: 'some-model',
      });
      expect(problems).toContain(`${key} is not set`);
    }
  });
});

describe('modelIds', () => {
  it('falls back to one agent model on the gateway and OpenRouter only', () => {
    for (const name of ['gateway', 'openrouter']) {
      expect(modelIds({}, name).agent).toBe('deepseek/deepseek-v4.1-flash');
    }
    expect(modelIds({}, 'anthropic').agent).toBeNull();
    expect(modelIds({ MOD_AGENT_MODEL: 'm' }, 'gateway').agent).toBe('m');
  });

  it('leaves DEFAULT_MODEL to lib/agent.js, where it is the configured agent model', () => {
    expect('DEFAULT_MODEL' in models).toBe(false);
  });
});

describe('modelProblems', () => {
  it('names a MODEL_BASE_URL that the chosen provider would not use', () => {
    // Inferred from the key, the provider is OpenRouter, so posts would go
    // there while the owner expects their own server.
    const problems = modelProblems({
      OPENROUTER_API_KEY: 'sk-or-test',
      MODEL_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(problems.join('\n')).toMatch(/MODEL_BASE_URL is set.*openrouter/);
  });

  it('names a MODEL_API_KEY that the chosen provider would not use', () => {
    const problems = modelProblems({
      MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      MODEL_API_KEY: 'key-for-a-local-server',
      MOD_AGENT_MODEL: 'claude-x',
    });
    expect(problems.join('\n')).toMatch(/MODEL_API_KEY is set.*anthropic/);
  });

  it('accepts both on openai-compatible, and blank lines from .env.example anywhere', () => {
    expect(
      modelProblems({
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_BASE_URL: 'http://localhost:11434/v1',
        MODEL_API_KEY: 'k',
        MOD_AGENT_MODEL: 'llama',
      }),
    ).toEqual([]);
    expect(
      modelProblems({
        OPENROUTER_API_KEY: 'sk-or-test',
        MODEL_BASE_URL: '',
        MODEL_API_KEY: '',
      }),
    ).toEqual([]);
  });
});

describe('MODEL_PROVIDER=none', () => {
  it('refuses a model call instead of falling through to the gateway', async () => {
    // The SDK resolves a string id through its own default provider, the
    // Vercel gateway, when none is installed. With `none`, nothing may leave.
    const fetch = recordingFetch();
    vi.stubGlobal('fetch', fetch);
    installProvider('none', {});
    await expect(
      generateText({
        model: 'deepseek/deepseek-v4.1-flash',
        prompt: 'a stranger’s post',
        maxRetries: 0,
      }),
    ).rejects.toThrow(/MODEL_PROVIDER=none/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
