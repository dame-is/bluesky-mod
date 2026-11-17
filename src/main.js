// The entry point. Settles who the owner and the bot are (identity.js), then
// loads the bot, whose modules read those settings when they are imported.

import { settleIdentities } from './identity.js';

const RETRY_MS = 30_000;

for (;;) {
  try {
    await settleIdentities(process.env);
    break;
  } catch (err) {
    console.error(`Not starting: ${err.message}`);
    // A handle nobody has, or one that changed hands, is the owner's to fix.
    if (!/could not look up/.test(err.message)) process.exit(1);
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

await import('./index.js');
