// Who is this message from, and what are they allowed to ask for?
//
// One module, so the boundary lives in one place.
//
//   owner    everything, including writes to the list
//   writer   answered, and may write. Empty by default
//   allowed  answered, read-only
//
// "Can talk to the bot" and "can add someone to a block list" are different
// powers, and only the first is cheap to grant. A guest account is usually the
// less carefully secured one, and a write from it lands on a live list real
// people subscribe to. So being answered is one tier and writing is another.
//
// A read-only guest can still see a lot: the analyst reads author feeds and
// the follow graph, and reports print bands, vouch counts and follower numbers
// for third parties. That is the owner's private reading of their own social
// graph, and adding someone hands them that. The tier limits what they can
// change, not what they can see.

/** DIDs out of a comma or whitespace separated env value. */
export function parseDids(value) {
  return [
    ...new Set(
      String(value ?? '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => /^did:[a-z]+:[a-zA-Z0-9._%-]+$/.test(s)),
    ),
  ];
}

/**
 * Build the roster.
 *
 * `answers` and `writes` are predicates rather than exported sets so callers
 * cannot accidentally mutate the boundary, and so a missing DID is a plain
 * `false` rather than a crash on an undefined set.
 *
 * @param {object} opts
 * @param {string} opts.owner           the account that owns the list
 * @param {string[]} [opts.writers]     may also write
 * @param {string[]} [opts.allowed]     answered, read-only
 */
export function makeRoster({ owner, writers = [], allowed = [] } = {}) {
  const canWrite = new Set([owner, ...writers].filter(Boolean));
  // A writer is answered without being named twice. Requiring both lists
  // would sooner or later mean an account that may write and is never heard.
  const answered = new Set([...canWrite, ...allowed].filter(Boolean));

  return {
    owner: owner ?? null,
    /** Is this DID answered at all? */
    answers: (did) => Boolean(did) && answered.has(did),
    /** May this DID run a command that changes the list? */
    writes: (did) => Boolean(did) && canWrite.has(did),
    /** Everyone answered. */
    all: [...answered],
    /** Everyone who may write, owner included. */
    allWriters: [...canWrite],
  };
}

/**
 * The roster the environment describes.
 *
 * `fallbackOwner` is `OWNER_DID`, passed in rather than imported so this module
 * stays pure and the config that reads it keeps deciding what the default is.
 */
export function rosterFromEnv(env = process.env, fallbackOwner = null) {
  return makeRoster({
    owner: env.MOD_OWNER_DID || fallbackOwner,
    writers: parseDids(env.MOD_WRITER_DIDS),
    allowed: parseDids(env.MOD_ALLOWED_DIDS),
  });
}
