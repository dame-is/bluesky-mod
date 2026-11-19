# The panel's API

The web panel is a page over a JSON API that the bot serves. The same API is there for an admin page of your own, on your own site, in your own styles. [YOUR-OWN-ADMIN.md](YOUR-OWN-ADMIN.md) walks through building one; this page is the reference.

The API is version 1. `GET /api/me` says which version a bot serves (`apiVersion`), and the number goes up only when a change would break a page written against the one before.

## Signing in

Every route but `POST /api/sign-in` needs a signed-in account from the bot's roster, and gives it the powers it has in DMs: the owner everything, `MOD_WRITER_DIDS` everything but the roster and the config file's text, `MOD_ALLOWED_DIDS` read-only. There are three ways to sign in:

| How | Sent as | For |
| --- | --- | --- |
| The panel's cookie | `Cookie: bm_panel=…` | The panel's own page. Same site only. |
| A token from your own PDS | `Authorization: Bearer <jwt>` | A site that signs you in with atproto OAuth |
| A panel session token | `Authorization: Bearer <token>` | A site without atproto sign-in, a server of your own, a script |

**A token from your own PDS** is a service-auth token: your site asks your PDS for it with `com.atproto.server.getServiceAuth`, with `aud` set to the bot's DID and `lxm` set to one of:

| `lxm` | Gives |
| --- | --- |
| `is.dame.blueskymod.read` | Reading only, whatever the roster allows |
| `is.dame.blueskymod.write` | What the roster allows |

The bot checks the token's signature against the key in your DID document (did:plc or did:web), and refuses one that lives longer than ten minutes. Nothing is shared between your site and the bot.

**A panel session token** is what the cookie holds, handed over instead of set. Ask the bot for a code by DM (`panel`), then:

```http
POST /api/sign-in
Content-Type: application/json
X-Panel-Request: 1

{ "code": "48219357", "token": true }
```

```json
{ "ok": true, "token": "…", "expiresAt": "2026-12-19T18:02:11.000Z" }
```

It lasts `PANEL_SESSION_DAYS` (30 by default). `POST /api/sign-out` with it as the bearer ends it, and the People page lists it with your other sign-ins.

## Calling from another site

A page on another site can call the API only when `PANEL_CORS_ORIGINS` names that site:

```bash
PANEL_CORS_ORIGINS=https://example.com,https://www.example.com
```

Such a page sends a bearer token. Cookies are never allowed across sites, so a stolen visit to your site cannot use the panel's cookie. A `POST` from a page with a bearer token needs no `X-Panel-Request` header; the panel's own page, which uses the cookie, still sends it.

## Answers and errors

Every answer is JSON. A refusal or a failure has a status and an `error` written to be shown to a person:

```json
{ "error": "Only the account the bot works for can do that." }
```

Times are ISO 8601 in UTC. Accounts are named by DID; `POST /api/profiles` turns DIDs into names and avatars. A plan is named by its eight-character code, the one the bot uses in DMs.

## Routes

Who: **any** is anyone signed in, **writer** needs a token or tier that may write, **owner** is the account the bot works for, signed in to write.

### You and the bot

| Route | Who | Takes | Gives |
| --- | --- | --- | --- |
| `GET /api/me` | any | | `apiVersion`, `did`, `tier` (owner, writer, reader), `canWrite`, `via` (cookie, atproto, token), `expiresAt`, `bot`, `owner`, `hasModel`, `dryRun` |
| `GET /api/health` | any | | What the process is doing: queue, last DM, disk, database, memory |
| `GET /api/settings` | any | | The bot's settings. The config file's text for the owner only, notes for writers |
| `GET /api/people` | any | | Who the bot answers (the owner sees everyone), and your sign-ins |
| `POST /api/sign-out` | any | | Ends this cookie or session token |
| `POST /api/sign-out-everywhere` | any | | Ends every sign-in for your account |

### The list

| Route | Who | Takes | Gives |
| --- | --- | --- | --- |
| `GET /api/lists` | any | | `multi`, and each list's `rkey`, `name` and size. With several lists (`MOD_MULTI_LIST`), any route below that takes `list` takes one of these record keys |
| `GET /api/overview` | any | `days` (7–90), `list` | List size and bands, adds and removals by day, what is waiting and running, the write budget, the newest changes |
| `GET /api/list` | any | `band`, `family` (name, band, label, agent), `q` (part of a handle, or a DID), `sort` (`closest` or `recent`), `offset`, `limit` (≤200), `list` | A page of the list: each account's band now and when added, vouches, how they got there, the plan, the tone label and quote |
| `GET /api/list/radar` | any | `list` | Everyone who is not a stranger, one mark each, and strangers as a count per way of being added |
| `GET /api/list/members` | any | `list` | The DIDs on the list by the bot's repo, and whether that read was `complete` |
| `GET /api/queue` | any | `band`, `offset`, `limit` (≤100) | Accounts on the list who are not strangers, closest first, each with a `reason`: `close`, or `closer` when the re-score moved them closer than when they were added |
| `POST /api/queue/keep` | writer | `{ did, band }` | Leaves them on the list and out of the queue until a re-score puts them closer |
| `POST /api/queue/reopen` | writer | `{ did }` | Puts a kept account back in the queue |
| `GET /api/protected` | any | `q`, `offset`, `limit` | Accounts no automated path may add, and why |
| `GET /api/activity` | any | `filter` (added, removed, undone), `offset`, `limit` | The decision log as events, a batch per line. Writers see the words that asked |

### Accounts and posts

| Route | Who | Takes | Gives |
| --- | --- | --- | --- |
| `GET /api/account` | any | `actor` (handle or DID) | A live score, every list they are on, whether they are protected or kept, and everything the log says about them |
| `POST /api/profiles` | any | `{ dids }` (≤100) | Names, handles, avatars and counts |
| `POST /api/check` | any | `{ link }` | Who engaged with a post and how close they are. Stores nothing |
| `GET /api/scans` | any | `state` (waiting, adding, added, cancelled, undone), `before` (a scan's `createdAt`), `limit` (≤100) | Scans, newest first, with `more` and `next` for the next page |
| `POST /api/scans` | any | `{ link, kind }` (everyone, likers, reposters, repliers, quoters) | Scans a post and keeps it as a plan: `{ code }`. Adds nobody |
| `GET /api/scan` | any | `code` | One plan and every account in it. `scan` is false for a typed block or removal |
| `GET /api/watches` | writer | | Watched posts, live and ended |
| `POST /api/watches/stop` | writer | `{ uri }` | Stops a watch |

### The follow graph and the shield

| Route | Who | Takes | Gives |
| --- | --- | --- | --- |
| `GET /api/graph` | any | | The snapshot scoring uses, the one being built, the protected counts and the last re-scores |
| `POST /api/graph/vouches` | any | `{ dids }` (≤1000), or `{ min, limit }` (≤5000) | `{ takenAt, scoring, vouches: { did: n } }`: how many of your follows follow each account, or the most followed. Accounts with none are left out |
| `POST /api/graph/rebuild` | owner | | Starts a new snapshot now: `{ started, reason }` |
| `POST /api/rescore` | owner | | Re-scores the list now, and DMs you what moved: `{ started }` |
| `GET /api/models` | any | `days` | Tokens spent by day, kind and model |
| `GET /api/shield` | any | | `running`, whether it can act (`canAct`, needs `MOD_OWNER_APP_PASSWORD`), attack mode, the per-post triggers, the stream, the `limits` it has set and the posts it is guarding |

### Changing things

| Route | Who | Takes | Gives |
| --- | --- | --- | --- |
| `POST /api/command` | depends | `{ command }` | The bot's reply: `action`, `text`, `outcome` (done, failed or null), follow-up `options`, and `choice` when it is asking which list |

`POST /api/command` is the one way the API changes the list or your posts. It takes the commands you would type in a DM, and runs them through the same code a DM goes through, on the bot's one queue, with the same PROTECTED veto, decision log and undo:

- `block <did>`, `unblock <did>`, `approve <code> UNKNOWN,NOTABLE`, `approve <code> hostile UNKNOWN`, `approve <code> <did> <did>…` (at most 25 by name), `undo <code>`, `cancel <code>`, and `triage <code>` to sort a plan's replies by tone (writers). With several lists, add `list:<rkey>`
- `shield status`, and for the owner alone `shields up`, `shields down`, `close replies <post>`, `open replies <post>`, `no quotes <post>`, `enable quotes <post>`, `keep closed <post>`, `guard <post>`, `unguard <post>`

An `undo` must name its plan, since a page may have been open a while. Anything else, such as a question for a model, is refused with a note to send it in a DM.
