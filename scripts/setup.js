// One-time setup for the bot account. Run it after filling in .env:
//
//   npm run setup                       (or: docker compose run --rm bot npm run setup)
//   npm run setup -- --name "quiet"     to choose the list's name
//
// It logs in as the bot and then:
//
//   1. checks the app password can read DMs;
//   2. lets anyone start a DM with the bot (chat.bsky.actor.declaration), so
//      you can reach it without the bot following you. The bot still answers
//      only the accounts in MOD_OWNER_DID / MOD_ALLOWED_DIDS / MOD_WRITER_DIDS;
//   3. creates the moderation list in the bot's repo if MOD_LIST_URI is unset,
//      or checks the one it names, and prints what to put in .env.
//
// Everything it writes is in the BOT's repo. It never touches yours.

import { botAgent, chatView } from '../src/bot/botAgent.js';
import { openDb, closeDb } from '../src/bot/db.js';

const args = process.argv.slice(2);
const nameAt = args.indexOf('--name');
const listName = nameAt >= 0 && args[nameAt + 1] ? args[nameAt + 1] : 'list';

const say = (line = '') => console.log(line);
const fail = (line) => {
  console.error(`\n${line}`);
  process.exitCode = 1;
};

async function main() {
  const missing = ['MOD_OWNER_DID', 'MOD_IDENTIFIER', 'MOD_APP_PASSWORD'].filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    return fail(`Set these in .env first: ${missing.join(', ')}`);
  }

  openDb();
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
  const declaration = await agent.com.atproto.repo
    .getRecord({ repo: did, collection: 'chat.bsky.actor.declaration', rkey: 'self' })
    .then((r) => r.data.value)
    .catch(() => null);
  if (declaration?.allowIncoming === 'all') {
    say('Incoming DMs: open to everyone already.');
  } else {
    await agent.com.atproto.repo.putRecord({
      repo: did,
      collection: 'chat.bsky.actor.declaration',
      rkey: 'self',
      record: { $type: 'chat.bsky.actor.declaration', allowIncoming: 'all' },
    });
    say(
      'Incoming DMs: opened to everyone, so you can message the bot without it following you. ' +
        'It still only answers the accounts in your roster.',
    );
  }

  // 3. The list.
  const existing = process.env.MOD_LIST_URI;
  if (existing) {
    const m = /^at:\/\/(did:[^/]+)\/app\.bsky\.graph\.list\/([^/]+)$/.exec(existing);
    if (!m) return fail(`MOD_LIST_URI is not a list URI: ${existing}`);
    if (m[1] !== did) {
      return fail(
        `MOD_LIST_URI is in ${m[1]}'s repo, not the bot's (${did}). The bot can only write to its own lists.`,
      );
    }
    const rec = await agent.com.atproto.repo
      .getRecord({ repo: did, collection: 'app.bsky.graph.list', rkey: m[2] })
      .catch(() => null);
    if (!rec) return fail(`MOD_LIST_URI names a list that does not exist: ${existing}`);
    say(`List: "${rec.data.value.name}" (${rec.data.value.purpose.split('#')[1]}) is ready.`);
  } else {
    const created = await agent.com.atproto.repo.createRecord({
      repo: did,
      collection: 'app.bsky.graph.list',
      record: {
        $type: 'app.bsky.graph.list',
        purpose: 'app.bsky.graph.defs#modlist',
        name: listName,
        createdAt: new Date().toISOString(),
      },
    });
    say(`List: created a moderation list called "${listName}".`);
    say('');
    say('Add this line to .env, then start the bot:');
    say('');
    say(`  MOD_LIST_URI=${created.data.uri}`);
  }

  const rkey = (process.env.MOD_LIST_URI || '').split('/').pop();
  const handle = agent.session?.handle;
  say('');
  say('Last steps, from your own account:');
  say(`  - Open the bot's profile (https://bsky.app/profile/${handle}), go to Lists, open the list and choose Subscribe > Block (or Mute).`);
  if (rkey) say(`    Direct link: https://bsky.app/profile/${handle}/lists/${rkey}`);
  say('  - Send the bot a DM saying "help".');
}

main()
  .catch((err) => fail(`Setup failed: ${err.message}`))
  .finally(() => closeDb());
