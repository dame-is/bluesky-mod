// The one way the panel changes the list: the bot's own commands.
//
// A click in the panel becomes the text of a command ("approve 3f2a1b7c
// UNKNOWN"). That text is parsed by the parser a DM goes through
// (src/lib/command.js) and run by the function a DM's command is run by
// (runCommand in src/bot/dmLoop.js), on the bot's one job queue. Nothing about
// a write is done again here, so the panel cannot add someone the DMs would
// refuse: the PROTECTED veto, the batch cap, the read-only gate and the
// decision log are the ones that were already there. The log keeps the
// command as the words that asked for the change, as it does for a DM.
//
// The panel has its own pages for reading, so only commands that change the
// list or label a plan are run here. Questions for a model stay in the DMs.

import { parseCommand, isWrite, readOnlyReply } from '../lib/command.js';

/** The commands the panel runs. */
export const PANEL_ACTIONS = new Set([
  'approve',
  'cancel',
  'undo',
  'list_add',
  'list_remove',
  'triage',
]);

const MAX_COMMAND_CHARS = 4000;

/**
 * Read a command before running it: is it one, is it one the panel runs, and
 * may this session run it.
 *
 * @returns {{ ok: true, cmd: object } | { ok: false, status: number, error: string }}
 */
export function checkCommand(text, { canWrite = false } = {}) {
  const raw = String(text ?? '').trim();
  const no = (status, error) => ({ ok: false, status, error });
  if (!raw) return no(400, 'There is no command in that request.');
  if (raw.length > MAX_COMMAND_CHARS || /[\r\n]/.test(raw)) {
    return no(400, 'Send one command on one line.');
  }
  const cmd = parseCommand(raw);
  if (!cmd) return no(400, 'That is not a command the bot knows.');
  if (!PANEL_ACTIONS.has(cmd.action)) {
    return no(
      400,
      `"${raw.split(/\s+/)[0]}" is not something the panel runs. Send it to the bot in a DM.`,
    );
  }
  if (isWrite(cmd) && !canWrite) return no(403, readOnlyReply(cmd));
  // In a DM a bare "undo" means the newest change. From a page that may have
  // been open for an hour it would mean whatever happened since, so the
  // panel always names the plan.
  if (cmd.action === 'undo' && !cmd.code) {
    return no(400, 'Name the plan to undo, as in "undo 3f2a1b7c".');
  }
  return { ok: true, cmd };
}

/**
 * Run one command for a signed-in session and say what it did.
 *
 * `deps.enqueue(label, job)` puts the job on the bot's queue and resolves
 * with what it returned, so a command from the panel waits its turn behind a
 * DM and nothing else writes while it runs.
 */
export async function runPanelCommand(text, session, deps) {
  const checked = checkCommand(text, session);
  if (!checked.ok) return checked;
  const { cmd } = checked;
  const reply = await deps.enqueue('panel', async () => {
    const writeAgent = deps.writeAgent();
    // The owner's conversation, so an approval too big for one batch can say
    // in a DM when the rest is done (continuation.js).
    const convoId =
      session.tier === 'owner' ? await deps.ownerConvo().catch(() => null) : null;
    return deps.runCommand(cmd, writeAgent, {
      lookUp: deps.lookUp,
      canWrite: session.canWrite,
      generate: deps.generate,
      model: await deps.model(),
      log: deps.log,
      convoId,
    });
  });
  return {
    ok: true,
    status: 200,
    action: cmd.action,
    text: reply?.text || '',
    outcome: reply?.outcome ?? null,
    // Follow-ups the bot offers with its receipt ("undo 3f2a1b7c"), kept only
    // where the panel could run them.
    options: (reply?.options || [])
      .filter((o) => checkCommand(o.command, session).ok)
      .map((o) => ({ label: o.label, command: o.command })),
  };
}
