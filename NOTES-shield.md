# The shield: notes for the docs

Fold into README.md, docs/HOW-IT-WORKS.md and .env.example, then delete this file.

## What it is

When a pile-on starts, the bot can change who may reply to your posts and whether they can be quoted, and put it back exactly once it is over. There are two levels:

- **Per-post triggers** (`MOD_SHIELD`). Past a threshold on one post, the bot closes replies on that thread to people you follow and people you mention, or turns quotes off on that post.
- **Attack mode** (`MOD_ATTACK`), a circuit breaker for everything at once. It closes replies and turns quotes off on every recent post, and detaches quote posts by strangers from the posts under fire. It gates new posts the moment you make them, and starts watches on the hottest posts, so the usual triage and 👍 decide who gets blocked. It trips on a pile-on across all your posts and mentions, or when you say "shields up". It stands down after `MOD_ATTACK_HOURS`, or when you say "shields down".

**Only people outside your circle count**: accounts in the UNKNOWN or NOTABLE band, by the same scoring every scan uses. Friends replying in a hurry never trip anything. An account that could not be scored counts as nobody, so an AppView outage cannot close anything.

The counts come from the Spacedust stream of replies, quotes and mentions aimed at you (`src/spacedust.js`, `src/ownerActivity.js`), so the shield needs `MOD_STREAM` on (the default).

## The security trade-off: your app password

Who may reply to a post, and whether it can be quoted, are records (a threadgate and a postgate) in **the post author's own repo**. Only a session for your account can write them. So the shield's writes need `MOD_OWNER_APP_PASSWORD`, **an app password for your own account**. This is a real change from "your password stays with you", so it is opt-in. Without it, the shield still notices and tells you, and offers what needs no password: a watch on the post.

What the bot does to keep that safe:

- **It must be an app password.** The config refuses anything not shaped `xxxx-xxxx-xxxx-xxxx`, and refuses the bot's own app password. After login, a session whose token has full account access (`com.atproto.access`, what the account password gives) is refused and never stored. An app password cannot delete the account or change its email or password, and you can revoke it in Settings > Privacy and Security > App Passwords at any time. It does not need DM access; don't tick that box.
- **It must be yours.** A password that logs in as any account but `MOD_OWNER_DID` is refused before anything uses it, and the shield runs without gates and says why (`shield` shows it).
- **It is used for gates and nothing else.** The session lives in `src/ownerAgent.js` and is handed only to `src/gates.js`. That module exposes five methods: list your recent posts, read one post, read a gate, read all gates, and write gates. Each method checks that the repo is yours, the collection is `app.bsky.feed.threadgate` or `app.bsky.feed.postgate`, and the post is one of your own. It throws on anything else before any request is made. The agent is never returned or exposed (tested in `src/gates.test.js`).
- **Its session is stored like the bot's**, in its own `owner_session` table, so restarts resume it instead of spending your account's login allowance (createSession is capped at 30 per 5 minutes and 300 a day). That table holds a refresh token for **your** account, one more reason the database is private.

What it still means: whoever can read the bot's environment or database can write gates on your posts, and with the password itself, do anything an app password can on your account (post, follow, block). If that is not a trade you want, leave it unset. The detection and the DMs still work.

## Settings

| Setting | Default | Is |
| --- | --- | --- |
| `MOD_OWNER_APP_PASSWORD` | unset | An app password for **your** account. Without it nothing is gated, only reported. |
| `MOD_OWNER_SERVICE` | your PDS from your DID document | Override for where to log in as you. |
| `MOD_SHIELD` | `off` | Per-post triggers: `off`, `ask` (DM with a 👍 and a menu) or `auto` (do it, then DM with the way back). |
| `MOD_SHIELD_REPLIES` | `12/15m` | Distinct accounts outside your circle replying in one thread within the window, to close replies. `0` or `off` turns this one off. |
| `MOD_SHIELD_QUOTES` | `6/15m` | The same for quotes of one post, to turn quotes off. |
| `MOD_SHIELD_REPLY_RULE` | `following,mentioned` | Who may still reply once replies are closed: any of `following`, `followers`, `mentioned`, or `nobody` alone. |
| `MOD_SHIELD_RESTORE_HOURS` | `24` | When a gate a trigger put on comes off by itself, once the post has had an hour with no strangers. `0` keeps it until you open it. |
| `MOD_ATTACK` | `ask` | Attack mode trip: `off`, `ask` or `auto`. |
| `MOD_ATTACK_TRIP` | `40/30m` | Distinct accounts outside your circle replying to, quoting or mentioning you, across everything, within the window. |
| `MOD_ATTACK_HOURS` | `24` | How long attack mode stays on. "shields up" again extends it. |
| `MOD_ATTACK_DAYS` | `7` | How far back "recent posts" go. A post under fire is gated however old it is. |
| `MOD_ATTACK_MAX_POSTS` | `100` | At most this many recent posts are gated. |
| `MOD_ATTACK_DETACH_QUOTES` | `true` | Detach quotes by strangers from the posts under fire (postgate `detachedEmbeddingUris`, at most 50 per post). |
| `MOD_ATTACK_HIDE_REPLIES` | `false` | Hide replies by strangers on the posts under fire (threadgate `hiddenReplies`, at most 50 per post). |
| `MOD_ATTACK_WATCHES` | `3` | Watches started on the hottest posts, in ask mode. Needs a model. |

Thresholds are `count/window`, with the window in minutes (`m`) or hours (`h`), up to 6 hours, which is as long as the stream keeps. A typo is refused at start.

### Why these defaults

- **Triggers are off.** A dozen strangers replying within a quarter hour is an ordinary good day for a post that travels. The existing alert already says when a post takes off.
- **Attack mode asks.** A trip is rarer and costlier to miss, and an ask changes nothing by itself: it is one DM with a 👍 and a menu. Auto would lock every recent post without anyone saying so, and that is your call to make.
- **Trigger gates come off after 24h, once quiet.** A gate the bot put on by itself should not outlive the pile-on that caused it. A gate that comes off by itself while strangers are still arriving would reopen the door mid-pile-on, so it waits for an hour with none. "keep closed" (option 2 on its message) makes it stay.
- **Hiding replies is off.** A hidden reply is hidden for everyone reading the thread, and a stranger defending you would be hidden as readily as one attacking you. Closing replies already stops new ones.
- **Detaching quotes is on in attack mode.** A dunk quote keeps your post as its payload. Detaching is undone at stand-down. Per-post triggers only turn quotes off and detach nothing.

## Commands

Parsed in code, never sent to a model, in classic and agent mode alike (`!` and `^` still work). Changes are **owner only**. Writers may change the list, not your posts. Anyone on the roster may ask for the status. The post comes from a shared post, a pasted link, or the post you sent last.

| Typed | Does |
| --- | --- |
| `shield` / `shield status` / `attack mode?` | What is on, the thresholds, how many posts the bot has limited, how long it has been listening |
| `shields up` / `attack mode` / `lockdown` [`for 12h`] | Attack mode on, or extended |
| `shields down` / `stand down` / `all clear` | Attack mode off, everything it changed put back |
| `close replies` / `lock replies` [post] [`to followers` / `to following and mentioned` / `to nobody`] | Close replies on that thread. Stays until you open it. |
| `open replies` [post] | Take the bot's reply limits off that post |
| `no quotes` / `disable quotes` [post] | Turn quotes off on that post |
| `enable quotes` / `quotes on` [post] | Take the bot's quote limits off that post |
| `keep closed` [post] | Stop a trigger's gate from coming off by itself |

Every reply ends in a numbered menu (open again, keep closed, watch it, shields up, stand down), so the usual answer is `1`. An ask-mode DM also stores a 👍 question, unless another question is already open in the conversation, which wins. A message that says more than the command ("stop replies from that guy", "shields up and block them all") is not read as one and goes on to the list commands or the model, so replies are never closed on a guess.

## What happens, exactly

- **Per-post trigger, ask:** "12 accounts outside your circle replied to <post> in 15 min." with `1. Close replies to following and mentioned`, `2. Watch it for 24 hours`, `3. Shields up everywhere`, and a 👍 that runs option 1.
- **Per-post trigger, auto:** the gate is written, then the same DM says so, with `1. Open replies again now`, `2. Keep it that way`, `3. Watch it`, `4. Shields up everywhere`.
- **One message per post per trigger per 6 hours**, at most two trigger messages a minute. An attack-mode question is asked at most every 2 hours. A pile-on is a few messages, never one per reply.
- **Attack mode on:** threadgates (on thread-starting posts) and postgates on every post from the last `MOD_ATTACK_DAYS`, plus any post under fire. The current gates are read in one listing per kind and the writes go in batches of 50 through `applyWrites`. New posts are gated as they land, from the owner's own Jetstream subscription, which now includes `app.bsky.feed.post`. Watches start on the hottest posts. Nobody is added to a list by attack mode itself; the watches ask.
- **While attack mode is on**, per-post triggers stay quiet, since attack mode already covers every post.

## Putting it back

Every gate the bot writes is recorded in `shield_gate` with what was there before, recorded *before* the write, so a gate on your post never exists without the record of how to take it off.

- **Exact.** Restoring writes back the previous record, or deletes the gate if there was none.
- **Only if untouched.** The previous record goes back only while the gate still reads exactly as the bot left it. If you changed it in your client since, it is yours, and it is left alone. The DM says so.
- **Never looser.** A post you had already limited keeps its limit. The bot only narrows to a subset of the groups already allowed, or to nobody. Hidden replies and detached quotes already there are kept, and so is any field it does not know.
- **Layers.** A trigger's gate and attack mode's on the same post come off in either order without stranding the other. If the trigger's comes off first, attack mode's takes over the job of putting back what the trigger found.
- **"open replies" / "enable quotes" lift every layer the bot put on that post**, attack mode's included: your explicit word wins. A limit you set yourself in a client is not the bot's, and stays (the reply says so).
- Restored records are forgotten after 90 days. Gates still on are kept for as long as they are on.

## Limits

- **No replay.** Spacedust has no cursor, so replies and quotes made while the bot was down or disconnected are not counted. A trigger's gate only comes off by itself once the stream has covered a full quiet hour.
- **Threadgates only work on a thread's first post.** A pile-on under one of your replies in someone else's thread cannot have its replies closed; quotes can still be turned off.
- **Replies made before closing stay**, unless `MOD_ATTACK_HIDE_REPLIES` hides them (up to 50 per post). Quotes made before turning quotes off stay attached unless detached (attack mode, up to 50 per post).
- **Dry run** (`DRY_RUN=true`) detects and logs what it would do, writes no gate, records nothing and sends nothing.
- **Without a snapshot**, nobody can be scored, so nothing counts as a stranger and nothing trips.
- **Without a model**, attack mode starts no watches.

## Files

`src/shield.js` (detection, apply and restore, attack mode, tick), `src/gates.js` (the narrow writer), `src/ownerAgent.js` (the owner's session), `src/bot/shieldDm.js` (DM handling and notices), `src/lib/shieldCommand.js` (the parser), `src/lib/shieldConfig.js` (settings), `src/lib/gateRules.js` (merge rules). New tables `owner_session`, `shield_gate` and `shield_state` are in `schema.sql`. There is one hook in `dmLoop.js` before both modes' lanes, and one branch in its `runPending`. `index.js` wires the owner session, a one-minute tick through the job queue that doesn't wait for a quiet minute, and new-post gating on Jetstream.
