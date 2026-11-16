# Setting it up on a VPS

This walks through a fresh Linux server with Docker. The worked example is a DigitalOcean droplet, but nothing here is specific to DigitalOcean: any VPS running Ubuntu or Debian works the same way. Notes for other kinds of hosting are at the end.

Budget about half an hour the first time.

## 1. Make the bot account

Create a new Bluesky account for the bot. Pick a handle and display name that don't point back to you. This account will own the list, so its name is what people see as the list's creator.

While logged in as the bot:

1. Settings > Privacy and Security > App Passwords > Add App Password.
2. Tick **Allow access to your direct messages**. Without it the bot can't read DMs and will hear nothing, silently.
3. Copy the password. You won't see it again.

Look up both DIDs (yours and the bot's). A DID is the permanent ID behind a handle:

```bash
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=your-handle.bsky.social"
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=the-bot.bsky.social"
```

## 2. Make the server

In DigitalOcean: Create > Droplets, Ubuntu 24.04 LTS, the smallest regular plan with **1 GB of memory**. 512 MB can work for someone who follows a few hundred accounts, but the follow-graph snapshot lives in memory while the bot answers, and 1 GB leaves room. Add your SSH key, create it, and note the IP address.

Log in and install Docker:

```bash
ssh root@YOUR_SERVER_IP
curl -fsSL https://get.docker.com | sh
```

## 3. Get the code and fill in the settings

```bash
git clone https://github.com/dame-is/bluesky-mod.git
cd bluesky-mod
cp .env.example .env
nano .env
```

Fill in:

- `MOD_OWNER_DID`: your DID
- `MOD_IDENTIFIER`: the bot's DID
- `MOD_APP_PASSWORD`: the app password from step 1
- a model, if you want one (see the comments in the file). Leave the model section empty to run with commands only; you can add one later.

Leave `MOD_LIST_URI` empty for now.

## 4. Run setup

```bash
docker compose run --rm bot npm run setup -- --name "a plain name"
```

This builds the image, logs in as the bot, checks it can read DMs, lets anyone start a DM with the bot (so you can reach it without the bot following you; it still answers only you), and creates the list. It prints a line like:

```
MOD_LIST_URI=at://did:plc:.../app.bsky.graph.list/3abc...
```

Paste that into `.env`.

## 5. Start it

```bash
docker compose up -d
docker compose logs -f
```

You should see `Chat access confirmed`, then `No follow-graph snapshot yet; building one`, then snapshot steps, then `Snapshot finalised`. The build reads who you follow and who each of them follows, so it takes a few minutes for a few hundred follows. The bot answers DMs while it runs.

Press Ctrl-C to stop watching the logs; the bot keeps running.

## 6. Subscribe, and say hello

From your own account:

1. Open the bot's profile, go to **Lists**, open the list.
2. Choose **Subscribe** and then **Block** or **Mute**. Blocking makes a public record in your repo that points at the list; muting is private. See the README for what that means.
3. Send the bot a DM: `help`.

Try `block` with a post shared into the DM, or `@someone` on its own to see how the bot scores them.

## Day to day

```bash
docker compose logs -f --tail 100   # what it's doing
docker compose restart              # after editing .env
git pull && docker compose up -d --build   # update to the latest code
```

### Backups

Everything lives in one SQLite file in the `data` volume. The follow-graph snapshot rebuilds itself if lost, but the decision log doesn't. To take a consistent copy while the bot runs:

```bash
F=backup-$(date +%F).db
docker compose exec bot node -e "new (require('node:sqlite').DatabaseSync)('/app/data/bluesky-mod.db').exec(\"vacuum into '/app/data/$F'\")"
docker compose cp bot:/app/data/$F ./$F
```

then move the copy somewhere off the server.

### Voice and limits

Copy `config/bot.example.json` to `config/bot.json` and edit it. The bot reads it on every answer; no restart needed. It's mounted read-only, so the bot can't change its own instructions.

## Other hosts

The bot is one long-running process that needs to keep a small file between restarts. Anywhere that gives you both will do.

- **Fly.io, Railway, Render and similar.** Deploy the Dockerfile, set the variables from `.env.example` in the host's settings, and attach a persistent volume at `/app/data`. Run exactly one instance, and turn off anything that scales to zero or starts a second copy during deploys: two copies polling the same DMs will both answer. Run setup once with the host's "run a command" feature (`npm run setup`).
- **A machine at home** (a spare laptop, a Raspberry Pi). Docker works the same way. Without Docker, install Node 22.13 or newer and use a systemd unit like this one:

  ```ini
  # /etc/systemd/system/bluesky-mod.service
  [Unit]
  Description=bluesky-mod
  After=network-online.target
  Wants=network-online.target

  [Service]
  WorkingDirectory=/opt/bluesky-mod
  EnvironmentFile=/opt/bluesky-mod/.env
  ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/index.js
  Restart=always
  RestartSec=5
  TimeoutStopSec=60
  User=bluesky-mod

  [Install]
  WantedBy=multi-user.target
  ```

- **Serverless functions** (Vercel, Netlify, Cloudflare Workers) don't fit: DMs can only be read by polling, every two seconds, and that needs a process that stays up.

## When something's wrong

| Symptom | Likely cause |
| --- | --- |
| The bot never answers | The app password lacks DM access, or your DID isn't `MOD_OWNER_DID`. Check the log for `Chat access FAILED`. |
| `the configuration is not usable` on start | The log lists each missing or malformed setting. |
| "the follow-graph snapshot is not built yet" | First start; wait for `Snapshot finalised` in the log. |
| A write fails with a permission error | `MOD_LIST_URI` isn't in the bot's repo. Rerun setup with it empty. |
| Answers about the wrong person's circle | `MOD_OWNER_DID` is set to the wrong account. |
