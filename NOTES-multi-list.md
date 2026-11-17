# Multi-list mode: notes for the docs

Material for README.md, docs/HOW-IT-WORKS.md and .env.example. Delete this
file once it is folded in.

## Setting

```
# Keep several moderation lists on the bot account and choose between them.
# Every moderation list in the bot's own repo is one you can choose; a block or
# an approval that names none asks "Which list?" and takes a number.
# MOD_MULTI_LIST=false
```

Off by default. Off, everything is exactly as before: one list, MOD_LIST_URI,
and nothing asks. `lists` and `new list` answer that the mode is off and how to
turn it on.

With no MOD_LIST_URI and several lists on the bot account, multi-list mode no
longer refuses to start: the oldest list becomes list 1. MOD_LIST_URI still
picks a different one.

## Which lists

The bot's repo is the registry. Every `app.bsky.graph.list` record with purpose
`modlist` in the bot account's own repo is a list you can choose; nothing in
any other repo ever is, because the bot can only write to its own repo (the
ownership check at the write is unchanged). Curation lists are not offered.

Numbering is stable: MOD_LIST_URI is always **1** (the "main" list), and the
rest follow in the order they were made. The lists are read from the bot's PDS
and held for 10 minutes; `lists` and `new list` read them afresh, so a list
made from a client signed in as the bot appears within 10 minutes, or at once
after `lists`. If the lists cannot be read and nothing was read before, a write
is refused ("I could not read your lists, so I changed nothing") rather than
sent to list 1 by guess.

## Commands

| Typed | Does |
| --- | --- |
| `lists` | The lists, numbered as the menus number them. Read-only senders may see it. |
| `new list <name>` | Makes a moderation list on the bot account, with the next number, and links it so you can subscribe. Refuses a name already in use (case, spaces and hyphens ignored), a name that is a number or "all", and names over 64 characters. A write: writers only. |
| `block @x to spam` | Names the list at the end: `to`, `on`, `onto` or `into`, then a name or a number, as the last two words. A unique start of a name works ("block" for "Block List"). |
| `... list:<rkey>` | The canonical token every menu writes, so an option means the same list whatever the lists are called later. Also typeable. |
| `unblock @x on all` | Off every list. |

Naming a list works on `block`/`list add`, `unblock`/`list remove`, `approve`,
`add likers <post> to spam` (the scan's numbered options then carry the list),
a card's words (`likers to trolls`), and `watch this and block the hostile ones
to spam`.

## The flows

**A write that names no list is not done.** The bot answers "Which list?" with
a numbered menu built by code, each option the same write by DID with
`list:<rkey>` on the end, and you answer `1`, `2` or `3`. With one list nothing
is asked. A list word that names none of the bot's lists ("to nazis") is said
back with the same menu, never guessed at.

```
you:  block @pest.bsky.social
bot:  Which list for @pest.bsky.social?

      reply with a number:
      1. Block List
      2. Spam
      3. Trolls
you:  2
bot:  Added @pest.bsky.social to Spam.
      ...
      1. Undo that          (takes them off Spam)
```

- **Classic mode**: typed commands, the post-scan menus, lookups.
- **Agent mode's quick lane** ("block" plus one target, no model): asks the
  same menu; a block that names its list stays quiet with a ✅, and the burst
  summary names the list each went on ("@a (Spam)").
- **A card's words** ("author and likers") and **a 👍 on a stored question**:
  one "Which list?" for everything they would run; each option runs all of the
  commands with the list on the ones that need it.
- **Unblock looks first.** On exactly one list: comes off it. On several (or
  Constellation cannot say for some): a menu of those lists plus "Every list".
  On none: "@x is not on any of your lists."
- **Plans are bound to one list.** The first approval of a plan binds it
  (`plan.list_uri`). Every later approval, continuation, undo and cancel uses
  that list, and an approval naming a different list is refused: "Plan 1c2d3e4f
  adds to Spam, so it cannot add to Trolls as well. Scan the post again and
  approve that scan to Trolls." A plan approved before the mode existed has no
  list_uri and counts as bound to list 1.
- **Watches**: a watch that blocks as it goes asks which list when it starts
  (or takes `to <list>`), and its plan is bound from the start. A watch that
  only reports needs no list; its digest's 👍 asks which list when it runs.
- **History** names the list on each row once there are several.
- **help** lists the new commands only when the mode is on.

## Agent mode

The write tools (`add_to_list`, `remove_from_list`, `approve_plan`, `watch_post`
with `block_hostile`) gain an optional `list` argument, in multi-list mode only
(with the mode off the tool schemas and the prompt are unchanged). The rule is
the one targets already follow: **the agent may not choose a list by itself.**

- A list is used when the owner's own words name it: the list's name as a
  phrase, its number after "list", "#" or "to/on/into", or its token, in the
  owner's message or their earlier messages. If the agent passes a list the
  owner never named, it is ignored and the owner is asked.
- The write check runs first, unchanged. When the list is known before the
  check it is in the check's description ("Add 1 account to the moderation list
  "Spam": ..."); with one list the description is word for word what it was.
- If the check allows the write and the owner named no list, nothing is
  written: the tool returns "not done, waitingOnOwner", and after the reply code
  sends one "Which list?" menu (the last message, so a `1` answers it) whose
  options run the writes through the classic commands and their vetoes. A
  write the check refuses goes the existing 👍 route, with the named list on the
  stored command when there was one; a 👍 on one without a list asks which.
- Removal follows the unblock rule: each account comes off the one list it is
  on, and anyone on several is asked about, with "Every list".
- An approval of a plan bound to one list naming another is refused with an
  error for the agent to relay.

## Design decisions and why

- **No env list of URIs.** The repo is already the truth about which lists
  exist; a second list in config would drift from it.
- **Canonical `list:<rkey>` in every menu option**, not the name or number: an
  option answered 30 minutes later still means the list it showed, even if a
  list was renamed or made in between.
- **Natural phrasing only as the last two words, only in multi-list mode, and
  only on verbs that write to a list** (and a scan). "pulse about going to
  work" is untouched, and a handle, DID or link is never read as a list.
- **One list per plan.** The decision table's key is (plan, account), so a plan
  could not record one account on two lists anyway; binding keeps undo, cancel
  and continuations unambiguous.
- **Cross-list safety.** Three places reasoned across all plans as if there were
  one list. Each is now scoped by the plan's list (`src/bot/planList.js`):
  - `closeAdds` (unblock, undo): taking someone off Spam closes only Spam's
    adds and clears only Spam plans' `already_listed` marks.
  - `addsElsewhere` / `heldByName` (undo): an add on another list no longer
    keeps someone on this one, nor is it closed by this undo.
  - `graphFacts` held copy and this process's recent writes are now per list.
    Before, an add to list X made `rkeysForWrite(Y, did)` return X's listitem
    rkey for up to 10 minutes, so an unblock from Y could have deleted the X
    entry. The held copy is one per list, so reading several lists for "on one
    of your lists" does not thrash.
  With the mode off every plan is on list 1, nothing is scoped, and the reads
  are the ones made before.
- **"Already on the list" in multi-list mode** means on any of the bot's lists
  (scans, cards, lookups say "on your lists"). Because a scan does not yet know
  which list it is for, scan and watch rows no longer pre-mark `already_listed`
  in multi-list mode; the write checks membership on the chosen list
  (`splitListed`), which then marks them for that plan. The card no longer
  greys out "author" just because the author is on some list.
- **Weekly re-score: list 1 only.** Kept on the primary list on purpose: a
  re-score is hundreds of AppView requests per few thousand accounts, and one
  brief per list would multiply both. Accounts on other lists are not
  re-scored. Worth revisiting if people keep large secondary lists.
- **The `plan.list_uri` column** is added by the ADDED_COLUMNS migration from
  the foundation commit. It is written only in multi-list mode (or for a plan
  bound to a non-primary list), so single-mode rows are unchanged.

## Limits

- Turning the mode off after using it: plans keep their list (undo and
  continuations still go to the list a plan was bound to), but a single-mode
  unblock is not scoped and closes adds on every list, as it always did.
- A list deleted from a client renumbers the ones after it; menus already sent
  still carry rkeys, and an rkey that no longer exists is refused.
- `namedIn` is a word match: an owner who writes "block this, it's spam" in
  agent mode names a list called "Spam". It only ever picks among the owner's
  own lists, for a write the check already allowed.
- Spacedust/Jetstream are untouched; nothing here needs a stream.

## Files

New: `src/lib/listChoice.js` (parser helpers), `src/bot/lists.js` (registry),
`src/bot/listPick.js` (choosing a list for a write), `src/bot/planList.js`
(plan → list, cross-plan scoping). Tests beside each, plus
`src/bot/dmLoop.lists.test.js` and `src/bot/operator.lists.test.js`.

Changed: `src/lib/command.js` (verbs, selectors), `src/bot/dmLoop.js`,
`src/bot/operator.js`, `src/bot/listWrite.js`, `src/bot/bulkPlan.js`,
`src/bot/closeAdds.js`, `src/bot/graphFacts.js`, `src/bot/watch.js` (a list on
startWatch, list_uri read, no pre-marking), `src/bot/reference.js`,
`src/bot/chatUx.js`, `src/lib/report.js` (help), `src/bootstrap.js`,
`src/config.js` (MOD_MULTI_LIST, beside dmMode).
