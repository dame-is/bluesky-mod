// One-time setup for the bot account. Run it after filling in .env:
//
//   npm run setup
//   npm run setup -- --name "quiet"       to choose the list's name
//   npm run setup -- --new                to make a list when the bot has one
//   docker compose run --rm bot npm run setup
//
// It checks that MOD_IDENTIFIER is the bot's DID and not yours, logs in as the
// bot and then:
//
//   1. checks the app password can read DMs;
//   2. lets anyone start a DM with the bot (chat.bsky.actor.declaration), so
//      you can reach it without the bot following you. The bot still answers
//      only the accounts in MOD_OWNER_DID / MOD_ALLOWED_DIDS / MOD_WRITER_DIDS;
//   3. checks the list MOD_LIST_URI names, or, when it is unset, creates a
//      moderation list in the bot's repo unless the bot already has one, and
//      prints what to put in .env.
//
// Everything it writes is in the BOT's repo. It never touches yours.

import { botAgent, chatView } from '../src/bot/botAgent.js';
import { openDb, closeDb } from '../src/bot/db.js';
import { identityProblems } from '../src/config.js';

const args = process.argv.slice(2);
const nameAt = args.indexOf('--name');
const listName = nameAt >= 0 && args[nameAt + 1] ? args[nameAt + 1] : 'list';
const makeNew = args.includes('--new');

const MODLIST = 'app.bsky.graph.defs#modlist';

const say = (line = '') => console.log(line);
const fail = (line) => {
  console.error(`\n${line}`);
  process.exitCode = 1;
};

async function main() {
  // Before logging in. With the owner's own DID and app password here, every
  // write below would land in the owner's repo, and a handle cannot be checked
  // against the account that logs in.
  const problems = identityProblems();
  if (problems.length) {
    return fail(`Fix these in .env first:\n  - ${problems.join('\n  - ')}`);
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
      record: {
        ...declaration,
        $type: 'chat.bsky.actor.declaration',
        allowIncoming: 'all',
      },
    });
    say(
      'Incoming DMs: opened to everyone, so you can message the bot without it following you. ' +
        'It still only answers the accounts in your roster.',
    );
  }

  // 3. The list.
  const existing = process.env.MOD_LIST_URI;
  let listUri = existing;
  if (existing) {
    const m = /^at:\/\/(did:[^/]+)\/app\.bsky\.graph\.list\/([^/]+)$/.exec(existing);
    if (!m) return fail(`MOD_LIST_URI is not a list URI: ${existing}`);
    if (m[1] !== did) {
      return fail(
        `MOD_LIST_URI is in ${m[1]}'s repo, not the bot's (${did}). The bot can only write to its own lists.`,
      );
    }
    // Only RecordNotFound means the list is gone. Any other failure, from the
    // network or the PDS, is reported as itself.
    const rec = await agent.com.atproto.repo
      .getRecord({ repo: did, collection: 'app.bsky.graph.list', rkey: m[2] })
      .catch((err) => {
        if (err?.error === 'RecordNotFound') return null;
        throw err;
      });
    if (!rec) return fail(`MOD_LIST_URI names a list that does not exist: ${existing}`);
    if (rec.data.value?.purpose !== MODLIST) {
      return fail(
        'MOD_LIST_URI is not a moderation list, and only a moderation list can be subscribed to as a block. ' +
          'Leave MOD_LIST_URI empty and run setup again to create one.',
      );
    }
    say(`List: "${rec.data.value.name}" is ready.`);
  } else {
    // A second run before MOD_LIST_URI is pasted in would otherwise make a
    // second list. The bot's existing moderation lists are offered instead.
    if (!makeNew) {
      const res = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection: 'app.bsky.graph.list',
        limit: 100,
      });
      const lists = (res.data.records || []).filter(
        (r) => r.value?.purpose === MODLIST,
      );
      if (lists.length) {
        const lines = lists
          .map((r) => `  MOD_LIST_URI=${r.uri}   ("${r.value.name}")`)
          .join('\n');
        return fail(
          `The bot already has ${lists.length === 1 ? 'a moderation list' : 'moderation lists'}, so setup did not make another:\n\n` +
            `${lines}\n\n` +
            'Paste the line you want into .env and run setup again, or run setup with --new to make a new list.',
        );
      }
    }
    const created = await agent.com.atproto.repo.createRecord({
      repo: did,
      collection: 'app.bsky.graph.list',
      record: {
        $type: 'app.bsky.graph.list',
        purpose: MODLIST,
        name: listName,
        createdAt: new Date().toISOString(),
      },
    });
    say(`List: created a moderation list called "${listName}".`);
    say('');
    say('Add this line to .env, then start the bot:');
    say('');
    say(`  MOD_LIST_URI=${created.data.uri}`);
    listUri = created.data.uri;
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
  .finally(() => closeDb());
