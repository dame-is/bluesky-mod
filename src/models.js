// Which company's models answer, chosen by environment.
//
// The rest of the code names models by plain string ids and hands them to the
// AI SDK. The SDK resolves a string through one global provider, so choosing
// one here moves every call, and nothing else knows which company answers.
//
//   MODEL_PROVIDER  gateway | openrouter | openai-compatible | anthropic |
//                   openai | none
//
// Unset, it is inferred from whichever key is present, in that order, and is
// `none` when there is no key at all. With `none` the bot still works: typed
// commands, scans, approvals, undo and the weekly re-score never call a model.
// Only the parts that read posts or sentences (the analyst, agent mode,
// triage) are switched off.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

export const PROVIDERS = [
  'gateway',
  'openrouter',
  'openai-compatible',
  'anthropic',
  'openai',
  'none',
];

/** Which provider the environment asks for, or implies. */
export function providerName(env = process.env) {
  const named = String(env.MODEL_PROVIDER || '').trim().toLowerCase();
  if (named) return named;
  if (env.AI_GATEWAY_API_KEY) return 'gateway';
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.MODEL_BASE_URL) return 'openai-compatible';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

export const PROVIDER = providerName();

/** Where each provider's key is read from, first choice first. */
const KEYS = {
  gateway: ['AI_GATEWAY_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY', 'MODEL_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'MODEL_API_KEY'],
  openai: ['OPENAI_API_KEY', 'MODEL_API_KEY'],
};

const keyFor = (name, env) =>
  (KEYS[name] || []).map((k) => env[k]).find(Boolean);

/** True when a model can be called at all. */
export const modelsEnabled = (name = PROVIDER) => name !== 'none';

/** The default model, where the provider names it the same way. */
export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * The model ids in use, from the environment over the defaults.
 *
 *   agent       answers DMs and mentions, and labels posts in triage.
 *               Defaults to DeepSeek V4.1 Flash on the gateway and OpenRouter;
 *               every other provider names models its own way, so it must be
 *               set there.
 *   check       answers the write check in agent mode. Defaults to the agent
 *               model: a separate call that reads only the owner's words and a
 *               description of the change, never the posts the agent read.
 *   escalation  optional second model: takes a turn the first fumbled, and
 *               re-reads posts labelled hostile. "off" by default.
 */
export function modelIds(env = process.env, name = providerName(env)) {
  const fallback =
    name === 'gateway' || name === 'openrouter' ? DEFAULT_MODEL : null;
  const agent = env.MOD_AGENT_MODEL || fallback;
  return {
    agent,
    check: env.MOD_CHECK_MODEL || agent,
    escalation: env.MOD_ESCALATION_MODEL || 'off',
  };
}

export const MODELS = modelIds();

/** Build the provider object the SDK resolves string ids through. */
export function createProvider(name = PROVIDER, env = process.env) {
  switch (name) {
    case 'gateway':
      // The SDK's own default. Reads AI_GATEWAY_API_KEY itself.
      return null;
    case 'openrouter':
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: env.MODEL_BASE_URL || 'https://openrouter.ai/api/v1',
        apiKey: keyFor('openrouter', env),
      });
    case 'openai-compatible':
      if (!env.MODEL_BASE_URL) {
        throw new Error('MODEL_PROVIDER=openai-compatible needs MODEL_BASE_URL');
      }
      return createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: env.MODEL_BASE_URL,
        apiKey: env.MODEL_API_KEY || undefined,
      });
    case 'anthropic':
      return createAnthropic({ apiKey: keyFor('anthropic', env) });
    case 'openai':
      return createOpenAI({ apiKey: keyFor('openai', env) });
    case 'none':
      return null;
    default:
      throw new Error(
        `MODEL_PROVIDER=${name} is not one of: ${PROVIDERS.join(', ')}`,
      );
  }
}

/**
 * Point the SDK's string ids at the chosen provider. Call once at startup,
 * before the first model call.
 */
export function installProvider(name = PROVIDER, env = process.env) {
  const provider = createProvider(name, env);
  if (provider) globalThis.AI_SDK_DEFAULT_PROVIDER = provider;
  return provider;
}

/** What is wrong with the model setup, as sentences. Empty when fine. */
export function modelProblems(env = process.env) {
  const name = providerName(env);
  if (!PROVIDERS.includes(name)) {
    return [`MODEL_PROVIDER=${name} is not one of: ${PROVIDERS.join(', ')}`];
  }
  if (name === 'none') return [];
  const problems = [];
  if (KEYS[name] && !keyFor(name, env)) {
    problems.push(`${KEYS[name][0]} is not set`);
  }
  if (name === 'openai-compatible' && !env.MODEL_BASE_URL) {
    problems.push('MODEL_BASE_URL is not set');
  }
  if (!modelIds(env, name).agent) {
    problems.push(`MOD_AGENT_MODEL is not set (needed with MODEL_PROVIDER=${name})`);
  }
  return problems;
}
