#!/usr/bin/env node
// Measure the agent-mode write check against scripts/evals/intent-cases.js.
//
// Each case is a message from the owner and a write the agent proposed. The
// check answers YES or NO, and this reports how often it was right. A FALSE
// ALLOW is the error that matters: a write the owner did not ask for. A false
// refusal costs one "go ahead?" message. The table keeps them apart.
//
// Uses the model provider in .env (src/models.js). From the repo root:
//   npm run eval:intent
//   npm run eval:intent -- --models model-a,model-b
//
// With no --models, it tests MOD_CHECK_MODEL (which defaults to the agent
// model). Run it again after changing the check prompt or the model.

import { generateText } from 'ai';

import {
  PROVIDER,
  MODELS,
  installProvider,
  modelProblems,
} from '../src/models.js';
import { CASES } from './evals/intent-cases.js';
import { intentState, CHECK_PROMPT } from '../src/bot/tiers.js';
import { actionText, accountPhrase, planPhrase } from '../src/bot/operator.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const CANDIDATES = String(arg('models', MODELS.check || ''))
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const problems =
  PROVIDER === 'none'
    ? ['No model provider is set up: set MODEL_PROVIDER and a key in .env.']
    : modelProblems();
if (!CANDIDATES.length) problems.push('No model to test.');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
installProvider();

/** The check's input for one case, built the way production builds it. */
function stateOf(c) {
  const action = actionText(c.kind, {
    accounts: (c.accounts || []).map(accountPhrase),
    plan: c.plan ? planPhrase(c.plan) : undefined,
    count: c.count,
    of: c.plan?.of,
    bands: c.bands,
    label: c.label,
  });
  return intentState({ said: c.said, earlier: c.earlier, action });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function score(decisions) {
  let right = 0;
  const falseAllow = [];
  const falseRefuse = [];
  decisions.forEach((d, i) => {
    if (d === CASES[i].want) right += 1;
    else if (d) falseAllow.push(CASES[i].id);
    else falseRefuse.push(CASES[i].id);
  });
  return { right, falseAllow, falseRefuse };
}

const states = CASES.map(stateOf);
console.log(
  `${CASES.length} cases: ${CASES.filter((c) => c.want).length} allow, ${CASES.filter((c) => !c.want).length} refuse\n`,
);

for (const model of CANDIDATES) {
  let tin = 0;
  let tout = 0;
  let failed = 0;
  const t0 = Date.now();
  const answers = await pool(states, 6, async (state) => {
    try {
      const r = await generateText({
        model,
        instructions: CHECK_PROMPT,
        messages: [{ role: 'user', content: state }],
      });
      tin += r.usage?.inputTokens || 0;
      tout += r.usage?.outputTokens || 0;
      const first = String(r.text || '')
        .trim()
        .split('\n')[0];
      if (/^\W*yes\b/i.test(first)) return true;
      if (/^\W*no\b/i.test(first)) return false;
      return null;
    } catch (err) {
      failed += 1;
      console.error(`${model} failed:`, err.message);
      return null;
    }
  });
  const ms = Date.now() - t0;
  // An unreadable or failed answer is a refusal, as it is in production.
  const s = score(answers.map((x) => x === true));
  console.log(
    `${model.padEnd(40)} ${String(s.right).padStart(2)}/${CASES.length}  ` +
      `false allow ${String(s.falseAllow.length).padStart(2)}  ` +
      `false refuse ${String(s.falseRefuse.length).padStart(2)}  ` +
      `${Math.round(ms / CASES.length)}ms/case, ${tin} in / ${tout} out tokens` +
      (failed ? `, ${failed} calls failed` : ''),
  );
  if (s.falseAllow.length) console.log('   false allows:', s.falseAllow.join(', '));
  if (s.falseRefuse.length)
    console.log('   false refusals:', s.falseRefuse.join(', '));
  console.log('');
}
