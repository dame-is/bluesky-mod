// Which company's models answer, chosen by environment.
//
// The rest of the code names models by plain string ids and hands them to the
// AI SDK. The SDK resolves a string through one global provider, so choosing a
// provider here is all it takes to move every call: nothing else in the code
// knows or cares which company is on the other end.
//
//   MODEL_PROVIDER     gateway | openrouter | openai-compatible | anthropic | openai | none
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

/** True when a model can be called at all. */
export const modelsEnabled = (name = PROVIDER) => name !== 'none';

/**
 * Defaults per provider, for the jobs that have one.
 *
 * Only the Vercel AI Gateway gets named defaults, because those ids were
 * measured against this code (see docs/HOW-IT-WORKS.md, "Two waves"). Every
 * other provider names models its own way, so the agent model must be set and
 * the rest fall back to it or turn off:
 *
 *   agent       answers DMs and mentions; triage's first reader
 *   judge       an evaluation model (gateway only): did the owner ask for this write?
 *   check       second opinion on a write, and the check itself when there is no judge
 *   escalation  takes a turn the first model fumbled; re-reads "hostile" labels
 */
export function modelDefaults(name = PROVIDER) {
  if (name === 'gateway') {
    return {
      agent: 'deepseek/deepseek-v4-flash',
      judge: 'typesafe-ai/jev',
      check: 'openai/gpt-6-luna',
      escalation: 'zai/glm-5.3-flash',
      escalationFallback: 'zai/glm-5.3',
    };
  }
  return {
    agent: null,
    judge: 'off',
    check: null, // filled with the agent model below
    escalation: 'off',
    escalationFallback: 'off',
  };
}

/** The model ids in use, from the environment over the defaults. */
export function modelIds(env = process.env, name = providerName(env)) {
  const d = modelDefaults(name);
  const agent = env.MOD_AGENT_MODEL || d.agent;
  return {
    agent,
    judge: env.MOD_JUDGE_MODEL || d.judge,
    // A write the agent chose is always checked by something, so with no
    // dedicated check model the agent's own model asks the question. It reads
    // only the owner's words and a description of the change, never the posts
    // the agent read, which is what makes it a check.
    check: env.MOD_CHECK_MODEL || d.check || agent,
    escalation: env.MOD_ESCALATION_MODEL || d.escalation,
    escalationFallback: env.MOD_ESCALATION_FALLBACK || d.escalationFallback,
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
        apiKey: env.OPENROUTER_API_KEY || env.MODEL_API_KEY,
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
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY || env.MODEL_API_KEY });
    case 'openai':
      return createOpenAI({ apiKey: env.OPENAI_API_KEY || env.MODEL_API_KEY });
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
  const key = {
    gateway: 'AI_GATEWAY_API_KEY',
    openrouter: env.OPENROUTER_API_KEY ? null : env.MODEL_API_KEY ? null : 'OPENROUTER_API_KEY',
    anthropic: env.ANTHROPIC_API_KEY || env.MODEL_API_KEY ? null : 'ANTHROPIC_API_KEY',
    openai: env.OPENAI_API_KEY || env.MODEL_API_KEY ? null : 'OPENAI_API_KEY',
  }[name];
  if (name === 'gateway' && !env.AI_GATEWAY_API_KEY) problems.push('AI_GATEWAY_API_KEY is not set');
  else if (key && name !== 'gateway') problems.push(`${key} is not set`);
  if (name === 'openai-compatible' && !env.MODEL_BASE_URL) {
    problems.push('MODEL_BASE_URL is not set');
  }
  if (!modelIds(env, name).agent) {
    problems.push(`MOD_AGENT_MODEL is not set (needed with MODEL_PROVIDER=${name})`);
  }
  if (name !== 'gateway' && env.MOD_JUDGE_MODEL && env.MOD_JUDGE_MODEL !== 'off') {
    problems.push('MOD_JUDGE_MODEL needs an evaluation model, which only the Vercel AI Gateway offers; unset it');
  }
  return problems;
}
