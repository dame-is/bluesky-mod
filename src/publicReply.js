// Posting the analyst's answer as a public reply.
//
// NO FACETS. A rich-text pass would turn any handle in the answer into a
// mention facet, and a mention NOTIFIES. The people in a moderation analysis
// should not get a notification saying they are in one, so handles go out as
// plain text and links go out unlinked.
//
// Chunks are threaded as self-replies, so a long answer reads in order and
// collapses into one unit in every client.

import { logger } from './logger.js';
import { config } from './config.js';

/**
 * @param {object} agent   an AtpAgent logged in as the moderator account
 * @param {{root: object, parent: object}} refs  from classify()
 * @param {string[]} chunks
 * @returns {Promise<string[]>} the URIs posted, in order
 */
export async function replyInThread(agent, refs, chunks) {
  if (config.dryRun) {
    logger.info('DRY_RUN: would post a public reply', {
      parent: refs.parent.uri,
      posts: chunks.length,
      first: chunks[0]?.slice(0, 120),
    });
    return [];
  }

  const posted = [];
  let parent = refs.parent;
  for (const text of chunks) {
    const res = await agent.post({
      $type: 'app.bsky.feed.post',
      text,
      langs: ['en'],
      createdAt: new Date().toISOString(),
      reply: { root: refs.root, parent },
    });
    parent = { uri: res.uri, cid: res.cid };
    posted.push(res.uri);
  }
  return posted;
}
