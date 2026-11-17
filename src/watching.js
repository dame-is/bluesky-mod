// The slow loops: watched posts, and the owner's own posts taking off.
//
// Both run in the one job queue, and only once the DMs have been quiet for a
// minute (index.js). Everything they say goes to the convo it is about, and
// anything they offer is stored as a question a 👍 answers.

import { generateText } from 'ai';

import { chunkForDm } from './lib/agent.js';
import { ownLinkFacets } from './lib/links.js';
import {
  liveWatches,
  checkWatch,
  digestFor,
  digestSent,
  expiredWatches,
  endWatch,
  ownPostAlerts,
  alertSent,
  alertText,
  WATCH_EVERY_MS,
} from './bot/watch.js';
import {
  savePending,
  confirmLine,
  questionOpen,
} from './bot/chatUx.js';

/**
 * Send one digest or alert, with its question stored when it asks one.
 * `links` are the URLs this code built and may render tappable.
 *
 * A QUESTION FROM THE CONVERSATION WINS. There is one stored question per
 * convo, and this runs on a timer while the owner may be mid-answer to
 * something the agent asked. When one is open, the message still goes, without
 * its 👍 line and without replacing what a "yes" or a 👍 would run.
 */
export async function say(
  chat,
  convoId,
  { text, pending, describe, links = [] },
) {
  if (!convoId || !text) return [];
  const asks = pending?.length > 0 && !(await questionOpen(convoId));
  const body = asks ? `${text}\n\n${confirmLine([describe])}` : text;
  const ids = [];
  for (const chunk of chunkForDm(body)) {
    const facets = ownLinkFacets(chunk, { allow: links });
    const sent = await chat.chat.bsky.convo.sendMessage({
      convoId,
      message: facets.length ? { text: chunk, facets } : { text: chunk },
    });
    if (sent?.data?.id) ids.push(sent.data.id);
  }
  if (asks) {
    await savePending(convoId, {
      commands: pending,
      describe,
      messageIds: ids,
      background: true,
    });
  }
  return ids;
}

/**
 * How long after a watch ends its closing digest is retried before the watch
 * is closed without it.
 */
const CLOSE_RETRY_MS = 24 * 3_600_000;

/**
 * Read every watch that is due, send the digests that are, end the expired.
 * `everyMs` is how often a watch is read again (MOD_WATCH_EVERY_MS).
 *
 * A digest waits while a question from the conversation is open in its convo:
 * the watch keeps reading, its counts keep adding up, and the update goes once
 * the owner has answered or the question has lapsed. A closing digest cannot
 * wait, so say() sends that one without a question of its own.
 *
 * A digest is recorded only once it has gone, and an expired watch is closed
 * only once its closing digest has gone, so a failed send is tried again on
 * the next tick. One watch failing does not stop the others.
 */
export async function tickWatches({
  chat,
  agent,
  reference,
  model,
  everyMs = WATCH_EVERY_MS,
  log = () => {},
  now = Date.now(),
}) {
  const asking = new Map();
  const busy = async (convoId) => {
    if (!asking.has(convoId)) {
      asking.set(convoId, await questionOpen(convoId, { now }));
    }
    return asking.get(convoId);
  };
  for (const w of await expiredWatches({ now })) {
    try {
      const d = await digestFor(w, { now, ending: true });
      if (d) await say(chat, w.convo_id, d);
      await endWatch(w, { now });
    } catch (err) {
      log('Closing digest failed', {
        uri: w.uri,
        err: String(err?.message || err),
      });
      if (now - Date.parse(w.until) >= CLOSE_RETRY_MS) {
        await endWatch(w, { now }).catch(() => {});
      }
    }
  }
  for (const w of await liveWatches({ now })) {
    // Half a minute of slack, so timer jitter does not skip a round.
    const due =
      !w.last_checked_at ||
      now - Date.parse(w.last_checked_at) >= everyMs - 30_000;
    if (!due) continue;
    try {
      const { io } = await reference();
      await checkWatch(
        w,
        {
          score: io.score,
          writeAgent: agent,
          generate: generateText,
          model,
          log,
        },
        { now },
      );
    } catch (err) {
      log('Watch check failed', {
        uri: w.uri,
        err: String(err?.message || err),
      });
      continue;
    }
    try {
      if (await busy(w.convo_id)) continue;
      const d = await digestFor(w, { now });
      if (d) {
        await say(chat, w.convo_id, d);
        await digestSent(w, { now });
        log('Sent a watch digest', { uri: w.uri });
      }
    } catch (err) {
      log('Watch digest failed', {
        uri: w.uri,
        err: String(err?.message || err),
      });
    }
  }
}

/**
 * Offer a watch on any of the owner's posts that has suddenly taken off.
 *
 * An alert is offered once, so it waits for the next tick while there is no
 * convo to send it to, or while a question from the conversation is open
 * (it would go out without the 👍 that is the point of it). It counts as
 * offered only once it has gone, so a failed send is offered again.
 */
export async function tickAlerts({
  chat,
  convoFor,
  log = () => {},
  now = Date.now(),
}) {
  const convoId = await convoFor();
  if (!convoId || (await questionOpen(convoId, { now }))) return 0;
  const alerts = await ownPostAlerts({ now });
  let sent = 0;
  for (const a of alerts) {
    try {
      await say(chat, convoId, alertText(a));
      await alertSent(a, { now });
      sent += 1;
      log('Offered a watch on a post taking off', {
        uri: a.uri,
        growth: a.growth,
      });
    } catch (err) {
      log('Alert failed', { uri: a.uri, err: String(err?.message || err) });
    }
  }
  return sent;
}
