// The only thing the owner's session is used for: reading the owner's recent
// posts, and reading and writing threadgates and postgates on them.
//
// The session (ownerAgent.js) can do anything an app password can on the
// owner's account: post, delete, follow, block. So it is closed over here and
// never handed out. Every method checks the repo (always the owner's), the
// collection (only threadgate and postgate are written) and the post (one of
// the owner's own), and throws on anything else, before any request is made.
// The object this returns holds methods and nothing else.

import { THREADGATE, POSTGATE } from './lib/gateRules.js';

const POST = 'app.bsky.feed.post';
const KINDS = { threadgate: THREADGATE, postgate: POSTGATE };

/** How many pages of posts recentPosts reads at most: 1,000 posts. */
const MAX_POST_PAGES = 10;

/** applyWrites takes up to 200 writes; 50 keeps one failure small. */
const BATCH = 50;

/** A record key as atproto allows it. */
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

/** A gate write was refused before it reached the network. */
export class GateRefused extends Error {}

/**
 * @param {object} opts
 * @param {() => object|null} opts.getAgent  the owner's agent, read on each
 *   call so a reconnect is picked up
 * @param {string} opts.ownerDid
 */
export function createGates({ getAgent, ownerDid }) {
  if (!ownerDid?.startsWith('did:')) throw new GateRefused('no owner DID');
  const prefix = `at://${ownerDid}/${POST}/`;

  function agent() {
    const a = getAgent();
    if (!a) throw Object.assign(new Error('the owner session is not connected'), { fromOwner: true });
    return a;
  }

  /**
   * One request on the owner's session. A failure is marked as the owner's,
   * so a dead session there is reconnected rather than taken for the bot's.
   */
  async function call(fn) {
    try {
      return await fn(agent());
    } catch (err) {
      if (err && typeof err === 'object') err.fromOwner = true;
      throw err;
    }
  }

  function collectionFor(kind) {
    const c = KINDS[kind];
    if (!c) throw new GateRefused(`only threadgates and postgates are written, not ${kind}`);
    return c;
  }

  /** The rkey of one of the owner's own posts, or a refusal. */
  function rkeyOf(postUri) {
    const uri = String(postUri ?? '');
    if (!uri.startsWith(prefix)) {
      throw new GateRefused(`${uri || 'that'} is not one of your posts`);
    }
    const rkey = uri.slice(prefix.length);
    if (!RKEY.test(rkey)) throw new GateRefused(`${uri} is not a post URI`);
    return rkey;
  }

  // A missing record is a 400 RecordNotFound from a PDS. Any other 400 is an
  // error, not "no gate there".
  const notFound = (err) =>
    err?.error === 'RecordNotFound' ||
    err?.status === 404 ||
    /record ?not ?found|could not locate record/i.test(String(err?.message || err));

  return Object.freeze({
    /**
     * The owner's posts from the last `days`, newest first, at most `max`.
     * `root` is false for a reply: a threadgate on a reply does nothing.
     */
    async recentPosts({ days = 7, max = 100, now = Date.now() } = {}) {
      const cutoff = now - days * 86_400_000;
      const out = [];
      let cursor;
      // A repo lists newest first by record key, but createdAt is whatever
      // the client wrote, and an imported archive backdates it. So an old
      // post does not end the listing; a page with nothing recent on it does.
      for (let page = 0; page < MAX_POST_PAGES && out.length < max; page += 1) {
        const res = await call((a) =>
          a.com.atproto.repo.listRecords({
            repo: ownerDid,
            collection: POST,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        const records = res?.data?.records || [];
        let recent = 0;
        for (const r of records) {
          if (!String(r.uri).startsWith(prefix)) continue;
          const at = Date.parse(r.value?.createdAt ?? '');
          if (Number.isFinite(at) && at < cutoff) continue;
          recent += 1;
          out.push({ uri: r.uri, root: !r.value?.reply, createdAt: r.value?.createdAt ?? null });
          if (out.length >= max) break;
        }
        cursor = res?.data?.cursor;
        if (!recent || !cursor || !records.length) break;
      }
      return out;
    },

    /** One of the owner's posts: whether it is a thread's first post. Null if gone. */
    async post(postUri) {
      const rkey = rkeyOf(postUri);
      try {
        const res = await call((a) =>
          a.com.atproto.repo.getRecord({ repo: ownerDid, collection: POST, rkey }),
        );
        return { uri: postUri, root: !res?.data?.value?.reply, createdAt: res?.data?.value?.createdAt ?? null };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    /** The gate of this kind on this post, or null when there is none. */
    async read(kind, postUri) {
      const collection = collectionFor(kind);
      const rkey = rkeyOf(postUri);
      try {
        const res = await call((a) =>
          a.com.atproto.repo.getRecord({ repo: ownerDid, collection, rkey }),
        );
        return res?.data?.value ?? null;
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    /**
     * Every gate of this kind in the owner's repo, by post URI, up to `max`.
     * One listing instead of a read per post, for attack mode.
     */
    async readAll(kind, { max = 1000 } = {}) {
      const collection = collectionFor(kind);
      const out = new Map();
      let cursor;
      // Bounded by pages as well as by size, so a server that keeps handing
      // back a cursor over the same records cannot hold the job queue.
      for (let page = 0; page < Math.ceil(max / 100) + 1 && out.size < max; page += 1) {
        const res = await call((a) =>
          a.com.atproto.repo.listRecords({
            repo: ownerDid,
            collection,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        const records = res?.data?.records || [];
        for (const r of records) {
          const rkey = String(r.uri).split('/').pop();
          out.set(`${prefix}${rkey}`, r.value ?? null);
        }
        cursor = res?.data?.cursor;
        if (!cursor || !records.length) break;
      }
      return out;
    },

    /**
     * Write gates. Each change is { kind, post, value, existed }: `value` null
     * deletes, `existed` says whether a record was there when it was read, so
     * the write is a create, an update or a delete. Batched through
     * applyWrites; a batch the PDS refuses (a gate written in between, say)
     * is written one record at a time instead, as put and delete, which do
     * not care what is there.
     *
     * @returns {Promise<number>} how many records were written
     */
    async write(changes) {
      const writes = changes
        .map((c) => {
          const collection = collectionFor(c.kind);
          const rkey = rkeyOf(c.post);
          if (c.value) {
            if (c.value.post !== c.post) throw new GateRefused('a gate must name the post it is on');
            if (c.value.$type !== collection) throw new GateRefused(`a ${c.kind} record must be a ${collection}`);
            return {
              $type: c.existed ? 'com.atproto.repo.applyWrites#update' : 'com.atproto.repo.applyWrites#create',
              collection,
              rkey,
              value: c.value,
            };
          }
          return c.existed ? { $type: 'com.atproto.repo.applyWrites#delete', collection, rkey } : null;
        })
        .filter(Boolean);
      let written = 0;
      for (let i = 0; i < writes.length; i += BATCH) {
        const batch = writes.slice(i, i + BATCH);
        try {
          await call((a) =>
            a.com.atproto.repo.applyWrites({ repo: ownerDid, writes: batch }),
          );
        } catch (err) {
          if (/rate ?limit/i.test(String(err?.message || err))) throw err;
          for (const w of batch) {
            if (w.$type.endsWith('#delete')) {
              await call((a) =>
                a.com.atproto.repo.deleteRecord({ repo: ownerDid, collection: w.collection, rkey: w.rkey }),
              ).catch((e) => {
                if (!notFound(e)) throw e;
              });
            } else {
              await call((a) =>
                a.com.atproto.repo.putRecord({
                  repo: ownerDid,
                  collection: w.collection,
                  rkey: w.rkey,
                  record: w.value,
                }),
              );
            }
          }
        }
        written += batch.length;
      }
      return written;
    },
  });
}
