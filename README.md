# bluesky-mod

A Bluesky moderation bot you run yourself. It owns a block list, takes instructions from you by DM, and refuses to add anyone you follow.

You send it a handle, a link or a shared post and say "block". It adds that account to a list on the bot's own account, and you subscribe to that list from yours. For bigger cleanups it can collect everyone who liked, reposted, replied to or quoted a post, sort them by how close they are to you, and add only the groups you approve. Everything it does can be undone.

## Why a separate bot account

- **The list isn't yours.** It belongs to the bot, so it doesn't show up among lists you made. Give the bot and the list plain names that don't point back to you.
- **Your password stays with you.** The bot holds an app password for its own account only.
- **What stays visible:** subscribing to a list as a *block* list writes a public record in your repo that points at the list. Anyone who looks at your repo directly can see you subscribe to it. Subscribing as a *mute* list is private. Choose with that in mind.

## What it does

With no AI model at all:

- **Block and unblock by DM.** "block" with a shared post, a pasted link or a typed `@handle`. One account, no model involved, about a second.
- **Scan a post.** `add likers <post>` (or `reposters`, `repliers`, `quoters`, `everyone`) collects who engaged, scores them, and proposes a batch. Nothing is added until you `approve <code> UNKNOWN` (or another band, or named accounts). `undo` takes back the last change when it was an add, one account or a batch.
- **A veto on people you know.** Accounts you follow and members of curation lists you made are PROTECTED. No path in the code can add them, including your own typed command.
- **A weekly re-score.** The bot re-scores everyone on the list and DMs you only when someone on it is no longer a stranger, has become PROTECTED, or has left Bluesky since the last run.
- **A decision log.** Every add and removal is recorded with your literal words, so "why is this person on the list" always has an answer, and `history @handle` shows it.

With a model:

- **Ask in plain words.** "what has @someone been posting about this week?" or "what's my circle talking about today?"
- **Agent mode.** Talk to it in sentences ("block whoever wrote this, and anyone in the quotes being hostile") instead of commands. Each write is first checked by a separate call that sees your words but not the posts the agent read, and the PROTECTED veto still holds.
- **Sort replies by tone.** Reads the replies and quotes on a post and labels each `hostile`, `arguing` or `neutral`, so you can add only the hostile ones, with their own words kept next to each label.
- **Watch a post.** Re-reads a post's new quotes and replies every few minutes for a day and tells you what came in. It can also offer to watch one of your posts when it suddenly takes off.

## How it decides who is close to you

The bot does not try to decide who is bad. It answers a narrower question: if you blocked this account, who would notice? The bands rest on one signal: **how many of the people you follow also follow them**.

| Band         | Means                                                            |
| ------------ | ---------------------------------------------------------------- |
| `PROTECTED`  | You follow them, or they're on a curation list you made. Never added. |
| `CONNECTED`  | 3 or more of your follows follow them, or 1 does and they're big |
| `PERIPHERAL` | 1 or 2 of your follows follow them                               |
| `NOTABLE`    | No connection, but a large or very active account                |
| `UNKNOWN`    | No connection. Most of any pile-on lands here.                   |

You approve batches by band. Approving `UNKNOWN` is a claim you can defend about a category; the closer bands are where you'd want to look first. [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) has the full reasoning, every command, and the security model.

## Run it

You need two Bluesky accounts, yours and a new one for the bot, and somewhere to run it that stays on. The easiest is Render:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dame-is/bluesky-mod)

It asks for three things: your handle, the bot's handle, and an app password for the bot with DM access. [docs/DEPLOY.md](docs/DEPLOY.md) explains those, and also covers Railway, Docker at home, Fly.io and a VPS such as a DigitalOcean droplet, with what each costs and how much disk the bot needs.

With Docker on any machine:

```bash
git clone https://github.com/dame-is/bluesky-mod.git
cd bluesky-mod
cp .env.example .env && chmod 600 .env   # fill in the three required lines
docker compose up -d
docker compose logs -f
```

On its first start the bot makes its list and logs a link to it. From your own account, open the link and subscribe (Block or Mute), then DM the bot "help". It spends a few minutes reading who you follow and who they follow, and answers DMs in between.

Without Docker, use Node 22.13 or newer: `npm ci --omit=dev`, fill in `.env`, `npm start`.

## Models

The model provider is one environment variable. Supported:

| `MODEL_PROVIDER`    | Needs                                   |
| ------------------- | --------------------------------------- |
| `gateway`           | `AI_GATEWAY_API_KEY` (Vercel AI Gateway) |
| `openrouter`        | `OPENROUTER_API_KEY`                    |
| `anthropic`         | `ANTHROPIC_API_KEY`, `MOD_AGENT_MODEL`  |
| `openai`            | `OPENAI_API_KEY`, `MOD_AGENT_MODEL`     |
| `openai-compatible` | `MODEL_BASE_URL`, `MOD_AGENT_MODEL` (Ollama, LM Studio, vLLM, Groq, Together, DeepSeek and others) |
| `none`              | nothing. Commands only.                 |

On the gateway and OpenRouter the model defaults to DeepSeek V4.1 Flash (`deepseek/deepseek-v4.1-flash`). Elsewhere, set `MOD_AGENT_MODEL` in the provider's own naming. The model has to support tool calling. Small local models work for the analyst but are weaker at agent mode; try classic mode first.

## What it stores

One SQLite file (`data/bluesky-mod.db`, in a Docker volume if you use Docker), or a Postgres database if you set `DATABASE_URL` ([docs/DEPLOY.md](docs/DEPLOY.md#with-your-own-database)): the follow-graph snapshot, proposed batches and every decision, the DM cursor, the bot's session token, notes you asked it to remember, and token counts for model calls from the last 90 days. It holds other people's posts where a batch was sorted by tone. Treat it as private and back it up; losing it loses the decision log. [docs/SETUP-VPS.md](docs/SETUP-VPS.md#backups) has the steps, including the one a restore needs.

How much it keeps is up to you: `MOD_SCORING=simple` skips the friends-of-friends half of the snapshot, which is nearly all of the file, and the `MOD_KEEP_*` settings say how long old scans, quotes and re-scores are kept.

The bot sends post text and handles to whichever model provider you configure, and the analyst's network lookups go to the Atmosphere MCP server at aturi.to (set `ATMOSPHERE=false` to turn that off). A post the analyst reads can try to steer those lookups. Lookups by URL or host are refused, but looking up a handle still reaches the host it names.

The bot also asks Spacedust, a public service at microcosm.blue, for replies, quotes and mentions aimed at your account as they happen, which tells that service whose account the bot watches (`MOD_STREAM=false` turns it off, and the bot polls instead).

## Settings

The settings most people change are in [.env.example](.env.example), commented. Voice, standing instructions and limits can go in an optional `config/bot.json` (see [config/bot.example.json](config/bot.example.json)), mounted read-only so the bot can't rewrite its own instructions.

## Development

```bash
npm install
npm test
DRY_RUN=true npm run dev   # reads no DMs and writes nothing
```

The store's tests run against SQLite, and against Postgres as well when `TEST_DATABASE_URL` names a database they may create schemas in.

## License

MIT
