# Setting it up on a VPS

This walks through a fresh Linux server with Docker, such as a DigitalOcean droplet. Any VPS running Ubuntu or Debian works the same way. [DEPLOY.md](DEPLOY.md) covers the easier hosts.

Budget about half an hour the first time.

## 1. Make the bot account

Create a new Bluesky account for the bot. Pick a handle and display name that don't point back to you. This account will own the list, so its name is what people see as the list's creator.

While logged in as the bot:

1. Settings > Privacy and Security > App Passwords > Add App Password.
2. Tick **Allow access to your direct messages**. Without it the bot can't read DMs and will hear nothing, silently.
3. Copy the password. You won't see it again.

## 2. Make the server

At any VPS provider, pick Ubuntu 24.04 LTS and a plan with **1 GB of memory** (on DigitalOcean, the 1 GB Basic droplet). 512 MB can work for someone who follows a few hundred accounts, but the follow-graph snapshot is held in memory while the bot answers, and 1 GB leaves room. Add your SSH key, create the server, and note its IP address.

Log in and install Docker:

```bash
ssh root@YOUR_SERVER_IP
curl -fsSL https://get.docker.com | sh
```

## 3. Get the code and fill in the settings

```bash
git clone https://github.com/dame-is/bluesky-mod.git
cd bluesky-mod
cp .env.example .env && chmod 600 .env
nano .env
```

Fill in:

- `MOD_OWNER_DID`: your handle, like `you.bsky.social`
- `MOD_IDENTIFIER`: the bot's handle
- `MOD_APP_PASSWORD`: the app password from step 1
- a model, if you want one (see the comments in the file). Leave the model section empty to run with commands only; you can add one later.

## 4. Start it

```bash
docker compose up -d
docker compose logs -f
```

On its first start the bot opens its DMs to everyone, so you can reach it without it following you (it still answers only you), and makes a moderation list. You should see `Made a moderation list for the bot` with a `subscribe` link, `Chat access confirmed`, then `No follow-graph snapshot yet; building one`, snapshot steps, and `Snapshot finalised`.

To check the account and the app password before the first start, `docker compose run --rm bot npm run setup` does the same setup from the command line and says what it found. The build reads who you follow and who each of them follows, so it takes a few minutes for a few hundred follows. The bot answers DMs while it runs.

Press Ctrl-C to stop watching the logs; the bot keeps running.

## 5. Subscribe, and say hello

From your own account:

1. Open the `subscribe` link from the log, or the bot's profile, **Lists**, and the list.
2. Choose **Subscribe** and then **Block** or **Mute**. Blocking makes a public record in your repo that points at the list; muting is private. See the README for what that means.
3. Send the bot a DM: `help`.

Try `block` with a post shared into the DM, or `@someone` on its own to see how the bot scores them.

## Day to day

```bash
docker compose logs -f --tail 100   # what it's doing
docker compose up -d                # after editing .env
git pull && docker compose up -d --build   # update to the latest code
```

### Backups

Everything that matters lives in one SQLite file in the `data` volume. The follow-graph snapshot rebuilds itself if lost, but the decision log doesn't. To take a consistent copy while the bot runs:

```bash
F=backup-$(date +%F).db
docker compose exec bot node -e "new (require('node:sqlite').DatabaseSync)('/app/data/bluesky-mod.db').exec(\"vacuum into '/app/data/$F'\")"
docker compose cp bot:/app/data/$F ~/$F && chmod 600 ~/$F
docker compose exec bot rm /app/data/$F
```

then move the copy somewhere off the server. It holds the bot's session token, so keep it as private as `.env`, and out of the checkout, where `git add` could pick it up.

To restore one, stop the bot, put the copy in place of the database, and clear the bot's place in the DM log before starting it again:

```bash
docker compose stop bot
docker compose run --rm -T bot sh -c 'umask 077; rm -f /app/data/bluesky-mod.db-wal /app/data/bluesky-mod.db-shm && cat > /app/data/bluesky-mod.db' < ~/backup-YYYY-MM-DD.db
docker compose run --rm bot node -e "new (require('node:sqlite').DatabaseSync)('/app/data/bluesky-mod.db').exec('delete from dm_cursor')"
docker compose up -d
```

Without the `delete from dm_cursor` step, the bot answers every DM sent since the backup as if it were new. With no place stored, it starts from the end of the log.

### Voice and limits

Copy `config/bot.example.json` to `config/bot.json` and edit it. The bot reads it on every answer; no restart needed. It's mounted read-only, so the bot can't change its own instructions.

## Without Docker

Install Node 22.13 or newer, create a `bluesky-mod` user, put the code in `/opt/bluesky-mod`, run `npm ci --omit=dev`, fill in `.env`, give that user the `data` directory (`chown -R bluesky-mod data`), and use a systemd unit like this one:

```ini
# /etc/systemd/system/bluesky-mod.service
[Unit]
Description=bluesky-mod
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/bluesky-mod
EnvironmentFile=/opt/bluesky-mod/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/main.js
Restart=always
RestartSec=5
TimeoutStopSec=60
User=bluesky-mod

[Install]
WantedBy=multi-user.target
```

## When something's wrong

| Symptom | Likely cause |
| --- | --- |
| The bot never answers | The app password lacks DM access, or `MOD_OWNER_DID` isn't your account. Check the log for `Chat access FAILED`. |
| `the configuration is not usable` on start | The log lists each missing or malformed setting. |
| "the follow-graph snapshot is not built yet" | First start; wait for `Snapshot finalised` in the log. |
| Answers about the wrong person's circle | `MOD_OWNER_DID` is set to the wrong account. |
| `now belongs to a different account` on start | A handle in `MOD_OWNER_DID` or `MOD_IDENTIFIER` moved to someone else since the first start. If that's really your new account, delete `identity.json` in the data volume, or set the DID instead. |
| `the bot has N moderation lists` on start | Set `MOD_LIST_URI` to the one to use; the log lists them. |
