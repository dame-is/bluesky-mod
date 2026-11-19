# An admin page on your own site

The panel the bot serves is one page over a JSON API. If you would rather look after your list from your own site, in your own styles, build a page over the same API. `bluesky-mod-client` is a small package for that: the API's calls, the band names, the command builders and the radar's layout, with no CSS and no dependencies. [API.md](API.md) lists every route.

dame.is does this: its admin area is a page of its own over its bot. Its moderation pages are in [`src/components/moderation/`](https://github.com/dame-is/dame.is/tree/main/src/components/moderation) of that site's repo.

## What the bot needs

1. **The panel on, at an HTTPS address.** `PANEL_PORT`, and a reverse proxy in front of it, with `PANEL_URL` set to that address. [PANEL.md](PANEL.md#reaching-it-from-somewhere-else) has the Caddy lines.
2. **Your site named in `PANEL_CORS_ORIGINS`**, so browsers let your page call it:

   ```bash
   PANEL_CORS_ORIGINS=https://example.com
   ```

Then, on your site:

```bash
npm install bluesky-mod-client
```

## Signing in

Your page signs in as an account on the bot's roster and gets what that account may do in DMs. Pick one way.

### Your site already signs you in with atproto

You sign in to your site with your own account, and the bot does the work with its own. Your page asks your PDS for a short-lived token addressed to the bot, and the client asks for another when it runs out. With an OAuth session from `@atproto/oauth-client-browser` and an `Agent` over it:

```js
import { createClient } from 'bluesky-mod-client';

const BOT_DID = 'did:plc:…'; // the bot account's DID

const bot = createClient({
  baseUrl: 'https://mod.example.com',
  auth: {
    serviceAuth: async () =>
      (await agent.com.atproto.server.getServiceAuth({ aud: BOT_DID })).data.token,
  },
});
```

The token is signed with your account's key and checked by the bot against your DID document, so nothing is shared between your site and the bot and there is no secret to keep. It names no method, so a PDS makes it for a minute at most; the client reuses it until shortly before then.

Your OAuth client has to be allowed to ask for these tokens. `transition:generic` allows it. With granular permissions, ask for `rpc?lxm=*&aud=<the bot's DID>%23bluesky_mod`, and ask for the token with `` aud: `${BOT_DID}#bluesky_mod` ``. The name after `#` can be anything; the bot takes its DID with or without one. That comes from the [permission spec](https://atproto.com/specs/permission) and the PDS's own `getServiceAuth`, read 2026-11-19, and has not yet been tried against a PDS with granular permissions.

### Your site has no atproto sign-in

Use a panel session token. Send the bot `panel` in a DM, and exchange the code for a token:

```js
const anon = createClient({ baseUrl: 'https://mod.example.com', auth: { token: '' } });
const { token, expiresAt } = await anon.signIn('4821 9357');

const bot = createClient({ baseUrl: 'https://mod.example.com', auth: { token } });
```

The token lasts `PANEL_SESSION_DAYS`, and anything that can run script on your page can use it until then. Keep it out of `localStorage` if you can: hold it in memory and sign in again, or keep it on your own server and have your page call that. `bot.signOut()` ends it, and so does the bot's People page.

### From a server or a scheduled job

If your server already logs in as you with an app password for your account, it can ask for the same token as a page does, and needs nothing else:

```js
import { AtpAgent } from '@atproto/api';

const agent = new AtpAgent({ service: 'https://your.pds.example' });
await agent.login({ identifier: process.env.BSKY_IDENTIFIER, password: process.env.BSKY_APP_PASSWORD });

const bot = createClient({
  baseUrl: process.env.BOT_URL,
  auth: { serviceAuth: async () => (await agent.com.atproto.server.getServiceAuth({ aud: BOT_DID })).data.token },
});
const { vouches } = await bot.vouches({ min: 2, limit: 500 });
```

The app password is for your account, not the bot's. The bot's own app password stays with the bot: whoever holds it can write to the list directly, past the PROTECTED veto and the decision log.

Otherwise, a panel session token kept in your server's environment works the same way, until it runs out (`PANEL_SESSION_DAYS`). A server needs no `PANEL_CORS_ORIGINS` entry; that is for browsers.

## A first page

The review queue, with a button to keep each account. Everything other people wrote, their handles and their words, goes on the page as text, never as markup.

```js
import { bandName, createClient } from 'bluesky-mod-client';

const bot = createClient({ baseUrl: 'https://mod.example.com', auth: { token } });

async function showQueue(el) {
  const me = await bot.me();
  const queue = await bot.queue({ limit: 30 });
  const names = (await bot.profiles(queue.rows.map((r) => r.did))).profiles;
  el.replaceChildren(
    ...queue.rows.map((row) => {
      const li = document.createElement('li');
      li.textContent = `@${names[row.did]?.handle || row.did} · ${bandName(row.band)}`;
      if (me.canWrite) {
        const keep = document.createElement('button');
        keep.textContent = 'Keep';
        keep.onclick = async () => {
          await bot.keep(row.did, row.band);
          li.remove();
        };
        li.append(' ', keep);
      }
      return li;
    }),
  );
}
```

Every call throws an `ApiError` with the bot's own words when it is refused, written to be shown to a person: `err.message`, and `err.status` (0 when the bot could not be reached).

## Changing the list

The API changes the list in one way: it sends the bot one of the commands you would type, and the bot runs it with the code a DM goes through. The PROTECTED veto, the decision log and undo are the bot's, so a page cannot do what a DM could not.

The client writes those commands for you. To approve part of a scan:

```js
import { approveCommand, selected } from 'bluesky-mod-client';

const plan = await bot.scan('3f2a1b7c');
const choice = { bands: ['UNKNOWN', 'NOTABLE'], hostileOnly: false };
const adding = selected(plan.rows, choice); // who it would add, to show first
const reply = await bot.command(approveCommand(plan.code, choice));
```

`reply.text` is what the bot would have said in a DM. `reply.options` are its follow-ups ("Undo all 412"), each a command you can send the same way. With several lists the bot may ask which one: `reply.choice` is true, nothing was done, and each option names a list.

`blockCommand`, `unblockCommand`, `undoCommand`, `cancelCommand` and `approveByName` cover the rest. `bot.keep()` and `bot.reopen()` change only the review queue, never the list.

## Styling it

The package ships no styles, so the page looks like the rest of your site. A few things that helped the stock panel:

- **Band colours as your own tokens.** `BANDS` gives the order, closest first, and `bandName` and `BAND_RULE` give the words. The colours are yours to choose; make sure each can be told apart without colour too, with a label or a shape.
- **The radar is layout, not drawing.** `place()` turns accounts into positions from -1 to 1, rings by band and slices by sector, and `texture()` gives marks for the strangers. Draw them on a canvas or in SVG in your own colours. The stock panel's [`radar.js`](../src/panel/public/radar.js) is one way.
- **Numbers and times** read the same as in the DMs with `nf`, `compact`, `ago` and `writeCost`.

## Trying it without a bot

Run the panel over invented data, with your page's address allowed:

```bash
PANEL_CORS_ORIGINS=http://localhost:5173 npm run panel:demo
```

It prints sign-in codes. Exchange one for a token with `signIn` as above and point your page at `http://127.0.0.1:8787`. The demo cannot check a token from your PDS, since your account is not on its roster.

## What a page cannot do

- **Ask a model.** Questions, digests and agent mode stay in the DMs.
- **Change the bot's instructions.** The config file is mounted read-only so the bot cannot rewrite it; the API shows it and nothing more.
- **Get past the veto.** It is in the bot, at the write.
