# Running it

The bot is one process that runs all the time and keeps one small database file. Any host that gives you both will do. If you're not sure, use Render: it takes a few clicks and no terminal.

| Host | You need | Rough cost | Disk | Effort |
| --- | --- | --- | --- | --- |
| [Render](#render) (recommended) | A Render account | About $7 a month, plus about $0.50 for the disk | 2 GB, can grow | A few clicks |
| [Railway](#railway) | A Railway account on the Hobby plan, and a GitHub account | About $5 a month | 5 GB | A few clicks |
| [Docker at home](#docker-at-home) | A computer that stays on, with Docker Desktop | Free | Your computer's | One command |
| [Fly.io](#flyio) | The `fly` command-line tool | About $3 to $4 a month | 2 GB, grows by itself to 10 GB | A few commands |
| [A VPS](#a-vps-such-as-a-digitalocean-droplet) (DigitalOcean, Hetzner and the like) | SSH and a little Linux | $4 to $6 a month | 10 to 25 GB | Half an hour |

Prices are as of November 2026; check each host's pricing page. Hosts that only run short-lived functions (Vercel, Netlify, Cloudflare Workers) don't fit: DMs can only be read by polling every two seconds, and the database needs a disk that stays.

## Before you start

Whatever the host, you need:

1. **A second Bluesky account for the bot.** Pick a handle and name that don't point back to you. This account owns the list, so its name is what people see as the list's creator.
2. **An app password for the bot**, made while logged in as the bot: Settings > Privacy and Security > App Passwords > Add App Password. Tick **Allow access to your direct messages**; without it the bot hears nothing. Copy the password, since you won't see it again.
3. **Three settings:**
   - `MOD_OWNER_DID`: your own handle, like `you.bsky.social`
   - `MOD_IDENTIFIER`: the bot's handle
   - `MOD_APP_PASSWORD`: the app password from step 2

A model key is optional and can be added any time later; see the model section of [.env.example](../.env.example). Without one, the bot still blocks, unblocks, scans posts, approves batches, undoes and re-scores weekly.

**After it starts,** on any host:

1. The log says `Made a moderation list for the bot` with a `subscribe` link. Open that link from your own account and choose **Subscribe**, then **Block** or **Mute**. Blocking makes a public record in your repo that points at the list; muting is private.
2. Send the bot a DM: `help`.

On its first start the bot reads who you follow and who each of them follows. That takes a few minutes, and it answers DMs in between.

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dame-is/bluesky-mod)

1. Press the button and sign in to Render.
2. Fill in the three settings when it asks, and press **Apply**. It builds the bot and starts it as a background worker with a 2 GB disk.
3. Open the service's **Logs** and wait for the subscribe link.

To add a model later: the service's **Environment** tab, add `MODEL_PROVIDER` and its key, and save. The bot restarts with it.

Updates don't happen on their own, so a change to this repository never reaches your bot by surprise. To update, choose **Manual Deploy > Deploy latest commit**.

## Railway

1. In Railway, **New Project > Deploy from GitHub repo**, and choose this repository or your fork of it. It builds from the Dockerfile.
2. In the service's **Variables**, add the three settings.
3. Attach a volume to the service with the mount path `/app/data`. On the Hobby plan it's 5 GB. The Free and Trial plans give 0.5 GB, which is only enough if you follow a few hundred accounts.
4. Deploy, and open the deploy's logs for the subscribe link.

Leave the service at one replica. A second copy waits for the first, but a copy on a different volume would answer every DM again.

## Docker at home

A spare laptop, a desktop that stays on, or a Raspberry Pi. The bot only works while the computer is on and awake, so turn off sleep.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine on Linux).
2. Get the code: `git clone https://github.com/dame-is/bluesky-mod.git`, or **Code > Download ZIP** on GitHub and unzip it.
3. In that folder, copy `.env.example` to `.env` and fill in the three settings.
4. In a terminal in that folder:

   ```bash
   docker compose up -d
   docker compose logs -f
   ```

The bot starts again by itself after a restart of the computer, once Docker is running.

## Fly.io

With [flyctl](https://fly.io/docs/flyctl/install/) installed and `fly auth login` done, in a checkout of the code:

```bash
fly launch --copy-config --no-deploy        # pick a name for the app
fly secrets set MOD_OWNER_DID=you.bsky.social MOD_IDENTIFIER=bot.bsky.social MOD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
fly deploy --ha=false                       # one machine; two would answer every DM twice
fly logs
```

The volume starts at 2 GB and grows by itself, 1 GB at a time, up to 10 GB (`fly.toml`).

## A VPS, such as a DigitalOcean droplet

A server you run yourself, with Docker. [SETUP-VPS.md](SETUP-VPS.md) walks through it on a fresh Ubuntu server, including backups and a systemd setup without Docker. On DigitalOcean, a 1 GB droplet is enough.

### With your own database

The bot keeps everything in one SQLite file in its data directory, on the same disk as the bot. That is the fastest option and the one every guide here uses. It can't keep its data in Supabase or another Postgres database today: that would need a Postgres version of `src/bot/db.js`. If you want your data off the server, back the file up instead ([SETUP-VPS.md](SETUP-VPS.md#backups)). Supabase's free plan also caps a database at 500 MB, which is less than the snapshot alone for someone who follows a couple of thousand accounts.

## How much disk it needs

Nearly all of the file is the follow-graph snapshot: one row for every account anyone you follow follows. While the weekly rebuild runs, it also holds every follow it read until they're counted. These figures assume each account you follow follows about 600, and use row sizes measured on the real schema, with two snapshots kept:

| You follow | The file, most of the week | At its largest, during the rebuild |
| --- | --- | --- |
| A few hundred accounts | Under 100 MB | About 250 MB |
| About 2,000 | About 550 MB | About 1 GB |
| 5,000 or more | About 1 GB | 2 to 3 GB |

Everything else is small. A scan of a post with 5,000 engagers adds about 1.3 MB to the decision log. Scans you never approve anything from are cleared after 30 days; anything a change to the list came from is kept for good. A weekly re-score of a 20,000-account list is about 3 MB, and only the newest four are kept.

So the defaults here are enough for most people: 2 GB on Render and Fly, which grows by itself, and 5 GB on Railway's Hobby plan. If you follow thousands of accounts, give Render a 5 GB disk. A disk can grow later; on Render and Fly it can't shrink.

### Keeping it smaller

If the disk is tight, or you'd rather keep less:

- `MOD_SCORING=simple` reads only who you follow, and counts anyone who follows you as close. The file stays at a few MB whoever you follow, and the snapshot takes seconds instead of minutes. The cost is that friends of friends who don't follow you score as strangers. [HOW-IT-WORKS.md](HOW-IT-WORKS.md#simple-scoring) has the details.
- `MOD_KEEP_SNAPSHOTS=1` keeps one snapshot instead of two, which roughly halves the file most of the week. The second is only a spare, used if the newest has to be dropped.
- `DRIFT_EVERY_HOURS=0` turns off the weekly re-score.
- The other `MOD_KEEP_*` settings in [.env.example](../.env.example) say how long scans, quotes and token counts are kept. They are small next to the snapshot.

The bot checks the disk every hour. When it runs low (under a tenth of the disk, or under 256 MB), it says so in the log and DMs you once a day, before anything starts failing.
