# The web panel

The bot is run from your DMs. Some of what it does is too big for a DM: a scan of 4,000 accounts, the whole list, a month of changes. The panel is a web page for those. It is served by the bot itself, shows what is in the bot's store, and changes the list only by sending the bot the commands you would have typed.

It is off unless you turn it on.

## Turn it on

Set a port in `.env` and restart the bot:

```bash
PANEL_PORT=8787
```

Without Docker, open `http://127.0.0.1:8787`. The panel answers that machine only.

With Docker, the bot's `127.0.0.1` is inside the container, so two more lines are needed. In `.env`:

```bash
PANEL_PORT=8787
PANEL_HOST=0.0.0.0
```

and in `compose.yaml`, under the `bot` service, the line that is there commented out:

```yaml
    ports: ["127.0.0.1:8787:8787"]
```

That publishes the port to the machine running Docker and to nothing else. Then `docker compose up -d` and open `http://127.0.0.1:8787`.

A dry run (`DRY_RUN=true`) leaves the panel off, because signing in is a DM and a dry run reads none.

## Signing in

There is no password. The bot already knows who it works for, so signing in is a DM:

1. Send the bot the word `panel`.
2. It answers with an eight-digit code.
3. Type the code into the panel's sign-in page.

A code works once and for ten minutes, and asking again replaces the one before. The browser then holds a cookie for 30 days (`PANEL_SESSION_DAYS`). The People page lists where you are signed in and can sign you out everywhere.

Anyone on the bot's roster can sign in, and gets the powers they have in DMs:

| In `.env` | In the panel |
| --- | --- |
| `MOD_OWNER_DID` | Everything |
| `MOD_WRITER_DIDS` | Everything, without the roster or the config file's text |
| `MOD_ALLOWED_DIDS` | Read-only. Sees bands, scans and what was done. Does not see the words that asked for a change, or your notes |

What an account may do is read from the roster on every request. Take someone off it, restart the bot, and their cookie stops working.

`panel` is matched as the whole message and answered by code in both DM modes. The reply is a credential, so a model never writes it.

## What is on each page

| Page | Shows | Can do |
| --- | --- | --- |
| Overview | The size of the list and who on it is near you, as a radar; what was added each day; scans waiting; what is being written; the newest changes | Open any of them |
| Review queue | Accounts on the list who are not strangers to you, as of the last re-score, closest first | Keep one on the list, or remove it |
| Scans | Every scan and its state | Scan a post |
| A scan | Everyone who engaged with the post, on a radar and in a table, with what they wrote and how a model read it | Add a ring, a slice, the hostile ones or named accounts; sort by tone; cancel; undo |
| Watches | Posts being re-read, and what came in | Stop one |
| The list | Everyone on the list, searchable, with where they stand now and how they got there | Open an account, take it off |
| Protected | The accounts nothing automated may add, and why | |
| Activity | Every add, removal and undo, with the words that asked for it | |
| Follow graph | The snapshot the bands rest on, and each re-score of the list | |
| Models and tokens | Which models are called, and tokens used by day and purpose | |
| People | Who the bot answers, and where you are signed in | Sign out everywhere |
| Settings | How the bot is set up and how it is running | |

Settings are shown and not edited. They live in `.env` and `config/bot.json`, which is mounted read-only so that whoever takes over the bot process cannot rewrite its instructions. The same goes for a web page.

Watches start in a DM (`watch this`), and so do questions for the model (`read`, `pulse`, `thread`).

## Reading the radar

You are at the centre. Each ring is a band: protected innermost, then connected, then peripheral, and everyone with no connection to you in the wide outer ring. Notable accounts are out there too, drawn as diamonds. The few hundred accounts near you get a mark each. Strangers are drawn as texture, with their number written in each slice.

On a scan the circle is cut by what people did: quoted, replied, reposted, liked. On the list it is cut by how each account came to be there: by name, by band, by tone label, or by agent mode or a watch. A bigger mark on a scan is an account whose reply or quote was read as hostile.

- Point at a mark for who it is, why they are in that ring, and what they wrote.
- Click a mark to open the account.
- On a scan, click a ring to tick it, and a corner label to narrow to that kind of engagement. What would be added stays bright and the rest dims.
- On the list, a ring or a label narrows the table underneath.
- With the radar in focus, the arrow keys walk the accounts near you from the centre out, and Enter opens one.

Everything in the picture is also in the table beside or under it. The picture is for seeing the shape of a batch before you approve it.

## How it changes the list

The panel does not write to Bluesky. Ticking rings on a scan builds the text of a command, shown under the count before you press anything:

```
approve 3f2a1b7c UNKNOWN
approve 3f2a1b7c UNKNOWN likers reposters
approve 3f2a1b7c hostile CONNECTED,UNKNOWN
approve 3f2a1b7c did:plc:… did:plc:…
```

That text goes to the bot, which parses it with the parser a DM goes through and runs it with the function a DM's command is run by, on the same one-job-at-a-time queue. So everything in [HOW-IT-WORKS.md](HOW-IT-WORKS.md) still holds:

- A protected account is refused at the write, whatever was ticked, including someone you followed after the scan.
- An approval writes 500 at a time. For the owner the rest carry on in the background, and the bot DMs you when they are done. A writer presses the button again.
- The decision log keeps the command as the words that asked for the change, and `undo` takes it back.
- A read-only account cannot run a command that writes.

The panel runs `approve`, `cancel`, `undo`, `block`, `unblock` and `triage`. A scan is the bot's own `add everyone <post>`. It will not run a bare `undo`: in a DM that means the newest change, and from a page that has been open for an hour it could mean something you have not seen. The panel always names the plan.

One thing is the panel's own. "Keep on the list" in the review queue records that you looked at an account and left it there, in a table called `review_keep`. It writes nothing to Bluesky. A kept account comes back to the queue only if a later re-score puts it closer to you than it was.

## Reaching it from somewhere else

Out of the box the panel can be opened only from the machine the bot runs on. To use it from a phone or another computer, in rising order of exposure:

- **An SSH tunnel.** `ssh -L 8787:127.0.0.1:8787 you@your-server`, then open `http://127.0.0.1:8787` on your own machine. Nothing is opened to the internet.
- **A private network** such as Tailscale or WireGuard. Set `PANEL_HOST` to the machine's address on that network.
- **HTTPS on a domain**, through a reverse proxy on the same machine. With Caddy:

  ```
  mod.example.com {
    reverse_proxy 127.0.0.1:8787
  }
  ```

  and in `.env`:

  ```bash
  PANEL_URL=https://mod.example.com
  ```

  `PANEL_URL` makes the cookie HTTPS-only, is the address the bot's DM tells you to type the code at, and is the only origin a request that changes something may come from.

On Render, Railway or Fly the bot is deployed as a worker with no web address (see [DEPLOY.md](DEPLOY.md)). Giving it one means changing it to a web service that routes to `PANEL_PORT`, with `PANEL_HOST=0.0.0.0` and `PANEL_URL` set to the address the host gives you.

Do not serve it over plain HTTP on a public address. The sign-in code and the cookie would cross the network in the clear.

### What stands between the internet and your list

- **A session comes only from a code the bot sent by DM** to someone on its roster. Whoever can read that person's DMs with the bot could already tell it what to do.
- **Five wrong codes** from one address, or twenty-five from all addresses together, and the panel refuses every code for ten minutes. That also means someone guessing can keep you out for ten minutes at a time.
- **The cookie** cannot be read by the page's scripts, and is not sent with requests from other sites.
- **A request that changes something** must carry a header only the panel's own page sends, and a browser's `Origin` must be the panel's.
- **The page loads nothing from elsewhere**, by its content security policy, except avatars from `cdn.bsky.app`.
- **What other people wrote**, their handles, names, bios and quotes, is only ever put on the page as text, never as markup.
- **The veto is not in the panel.** It is in the bot, at the write.

## What it stores and sends

Three tables are added to the bot's store: sign-in codes and sessions, both as SHA-256 hashes, and the accounts you chose to keep in the review queue.

Names and avatars are not in the store. The bot fetches them from the public AppView as pages are opened and holds them in memory for half an hour. Your browser then loads avatar images from `cdn.bsky.app`, which tells Bluesky's image host that someone at your address looked at those accounts.

The panel shows the same things the DMs can: other people's posts where a scan was sorted by tone, and your reading of your own social graph. Treat a signed-in browser as you treat the database.

## Try it without a bot

```bash
npm install
npm run panel:demo
```

That serves the real panel at `http://127.0.0.1:8787` over invented data, with no Bluesky account and no network, and prints two sign-in codes: one for the owner and one for a read-only guest. A stand-in for the bot writes to the demo's store where the real one would write to Bluesky, so the buttons do what they say. It is for looking at the pages and working on them. Nothing about how the bot decides should be read from it.

## What it does not do

- Start a watch, ask the model a question, or keep a note. Those are DMs.
- Change a setting.
- Show a refusal after the fact. A block the veto refused wrote nothing, so the log has no line for it; the panel says so at the time.
- Know the list's bands before the first weekly re-score. Until then it shows the band each account had when it was added.
- Price tokens. The bot counts them and does not know what your provider charges.
