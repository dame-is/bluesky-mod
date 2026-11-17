// Optional setup for the bot account, for checking things from the command
// line before the first start. The bot does steps 2 and 3 by itself when it
// starts. Run it after filling in .env:
//
//   npm run setup
//   npm run setup -- --name "quiet"       to choose the list's name
//   npm run setup -- --new                to make a list when the bot has one
//   docker compose run --rm bot npm run setup
//
// It checks that MOD_IDENTIFIER is the bot's account and not yours, logs in as
// the bot and then:
//
//   1. checks the app password can read DMs;
//   2. lets anyone start a DM with the bot (chat.bsky.actor.declaration), so
//      you can reach it without the bot following you. The bot still answers
//      only the accounts in MOD_OWNER_DID / MOD_ALLOWED_DIDS / MOD_WRITER_DIDS;
//   3. checks the list MOD_LIST_URI names, or, when it is unset, creates a
//      moderation list in the bot's repo unless the bot already has one.
//
// Everything it writes is in the BOT's repo. It never touches yours.

import { settleIdentities } from '../src/identity.js';

const args = process.argv.slice(2);
const nameAt = args.indexOf('--name');
const listName = nameAt >= 0 && args[nameAt + 1] ? args[nameAt + 1] : 'Block list';
const makeNew = args.includes('--new');

const say = (line = '') => console.log(line);
const fail = (line) => {
  console.error(`\n${line}`);
  process.exitCode = 1;
};

async function main() {
  // Handles become DIDs first, and the modules that read them are loaded
  // after, as src/main.js does for the bot.
  try {
    await settleIdentities(process.env);
  } catch (err) {
    return fail(`Fix this in .env first: ${err.message}`);
  }
  const { identityProblems } = await import('../src/config.js');
  // Before logging in. With the owner's own DID and app password here, every
  // write below would land in the owner's repo.
  const problems = identityProblems();
  if (problems.length) {
    return fail(`Fix these in .env first:\n  - ${problems.join('\n  - ')}`);
  }

  const db = await import('../src/bot/db.js');
  const { botAgent, chatView } = await import('../src/bot/botAgent.js');
  const { ensureDmsOpen, moderationLists, createList, listProblem } =
    await import('../src/bootstrap.js');

  db.openDb();
  const { agent } = await botAgent();
  const did = agent.session?.did;
  say(`Logged in as @${agent.session?.handle} (${did}).`);

  // 1. DM access.
  const chat = chatView(agent);
  try {
    await chat.chat.bsky.convo.getLog({});
    say('DM access: ok.');
  } catch (err) {
    return fail(
      'DM access FAILED. Make a new app password for the bot with "Allow access to your direct messages" ticked ' +
        '(Settings > Privacy and Security > App Passwords) and put it in MOD_APP_PASSWORD.\n' +
        `(${err.message})`,
    );
  }

  // 2. Who may start a DM with the bot.
  say(
    (await ensureDmsOpen(agent)) === 'already'
      ? 'Incoming DMs: open to everyone already.'
      : 'Incoming DMs: opened to everyone, so you can message the bot without it following you. ' +
          'It still only answers the accounts in your roster.',
  );

  // 3. The list.
  const existing = process.env.MOD_LIST_URI;
  let listUri = existing;
  if (existing) {
    const problem = await listProblem(agent, existing);
    if (problem) return fail(problem);
    const name = (await moderationLists(agent)).find((l) => l.uri === existing)?.name;
    say(`List: "${name}" is ready.`);
  } else {
    // A second run would otherwise make a second list. The bot's existing
    // moderation lists are offered instead.
    if (!makeNew) {
      const lists = await moderationLists(agent);
      if (lists.length) {
        const lines = lists
          .map((l) => `  MOD_LIST_URI=${l.uri}   ("${l.name}")`)
          .join('\n');
        return fail(
          `The bot already has ${lists.length === 1 ? 'a moderation list' : 'moderation lists'}, so setup did not make another:\n\n` +
            `${lines}\n\n` +
            'Paste the line you want into .env, or leave MOD_LIST_URI empty and the bot uses its one list. Run setup with --new to make a new list.',
        );
      }
    }
    const created = await createList(agent, listName);
    say(`List: created a moderation list called "${listName}".`);
    say('');
    say('The bot finds it by itself, or add this line to .env to name it:');
    say('');
    say(`  MOD_LIST_URI=${created.uri}`);
    listUri = created.uri;
  }

  const rkey = listUri.split('/').pop();
  const handle = agent.session?.handle;
  say('');
  say('Last steps, from your own account:');
  say(`  - Open the bot's profile (https://bsky.app/profile/${handle}), go to Lists, open the list and choose Subscribe > Block (or Mute).`);
  say(`    Direct link: https://bsky.app/profile/${handle}/lists/${rkey}`);
  say('  - Once the bot is running, send it a DM saying "help".');
}

main()
  .catch((err) => fail(`Setup failed: ${err.message}`))
  .finally(async () => (await import('../src/bot/db.js')).closeDb());
