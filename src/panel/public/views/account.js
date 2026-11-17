// One account, opened over whatever page you were on: who they are, where
// they stand to you now, whether they are on the list and how they got
// there, and everything the log holds about them.

import { get } from '../api.js';
import { h, fill, icon } from '../dom.js';
import { BAND_RULE, ago, clock, compact, nf, shortDid, viaWords } from '../lib/format.js';
import { blockCommand, unblockCommand } from '../lib/commands.js';
import { avatar, band, closeButton, confirm, loadProfile, loading, problem, run, tone } from '../ui.js';

function reasonLine(live) {
  if (!live) return null;
  if (live.protectedReason) return `Protected: ${live.protectedReason}.`;
  const v = live.vouches || 0;
  if (v) return `${nf(v)} of the people you follow follow them.`;
  if (live.band === 'NOTABLE') return 'Nobody you follow follows them, but a lot of people do.';
  return 'Nobody you follow follows them.';
}

function entryTitle(e) {
  if (e.action === 'list_remove') return 'Removed from the list';
  if (e.action === 'list_add') {
    if (e.already) return 'Asked for again, already on the list';
    return e.undoneAt ? 'Added, and since taken back' : 'Added to the list';
  }
  return e.scan ? 'In a scan, not added' : 'Recorded';
}

export function openAccount(actor, ctx) {
  let close = () => {};
  const body = h('div', { class: 'section' }, loading('Looking them up.'));
  const el = h(
    'aside',
    { 'aria-label': 'Account' },
    h('div', { class: 'sheet-head' }, h('h2', null, 'Account'), closeButton(() => close())),
    body,
  );

  async function load() {
    fill(body, loading('Looking them up.'));
    let a;
    try {
      a = await get('/api/account', { actor });
    } catch (err) {
      return fill(body, problem(err, load));
    }
    const profile = (await loadProfile(a.did)) || {};
    const live = a.live;
    const handle = profile.handle || live?.handle || null;
    const name = profile.displayName || live?.displayName || handle || shortDid(a.did);
    const face = avatar(profile, { large: true, fallback: handle || '' });
    const onList = a.onList;
    const isProtected = Boolean(live?.protectedReason || a.protectedReason);

    const after = async () => {
      await load();
      ctx.refresh();
    };
    const add = async () => {
      const ok = await confirm({
        title: `Add ${handle ? `@${handle}` : 'this account'} to the block list?`,
        body: h('p', null, reasonLine(live) || 'The bot will check they are not protected before it writes.'),
        command: blockCommand(a.did),
        yes: 'Add to the list',
        danger: true,
      });
      if (ok) await run(blockCommand(a.did), { after });
    };
    const remove = async () => {
      const ok = await confirm({
        title: `Take ${handle ? `@${handle}` : 'this account'} off the block list?`,
        command: unblockCommand(a.did),
        yes: 'Take off the list',
      });
      if (ok) await run(unblockCommand(a.did), { after });
    };

    const facts = [
      profile.followers != null ? `${compact(profile.followers)} followers` : null,
      profile.posts != null ? `${compact(profile.posts)} posts` : null,
      profile.createdAt ? `joined ${ago(profile.createdAt)}` : null,
    ].filter(Boolean);

    return fill(
      body,
      h(
        'div',
        { class: 'profile' },
        face.el,
        h(
          'div',
          null,
          h('div', { class: 'profile-name' }, name),
          handle ? h('div', { class: 'muted' }, `@${handle}`) : null,
          profile.missing ? h('div', { class: 'muted' }, 'No longer on Bluesky.') : null,
          profile.description ? h('p', { class: 'profile-bio' }, profile.description) : null,
          facts.length ? h('p', { class: 'muted' }, facts.join(', ')) : null,
          h('p', null, h('a', { href: `https://bsky.app/profile/${a.did}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open on Bluesky ', icon('out', 14))),
        ),
      ),

      h(
        'dl',
        { class: 'rows' },
        h('div', null, h('dt', null, 'To you, now'), h('dd', null, live ? [band(live.band), h('div', { class: 'muted' }, reasonLine(live))] : h('span', { class: 'muted' }, a.failed ? `Could not be scored now: ${a.failed}` : 'Not scored'))),
        live ? h('div', null, h('dt', null, 'What that means'), h('dd', null, BAND_RULE[live.band] || '')) : null,
        h(
          'div',
          null,
          h('dt', null, 'On the list'),
          h(
            'dd',
            null,
            onList
              ? [
                  onList.addedAt ? `Yes, since ${ago(onList.addedAt)}. ` : 'Yes. ',
                  viaWords(onList.via),
                  onList.code ? ['. ', h('span', { class: 'mono' }, onList.code)] : null,
                ]
              : 'No',
          ),
        ),
        live?.blocksYou ? h('div', null, h('dt', null, 'Blocks you'), h('dd', null, 'Yes. They cannot reply to you or quote you.')) : null,
        live?.followsYou ? h('div', null, h('dt', null, 'Follows you'), h('dd', null, 'Yes')) : null,
        a.kept ? h('div', null, h('dt', null, 'Review queue'), h('dd', null, `Kept on the list ${ago(a.kept.at)}.`)) : null,
        h('div', null, h('dt', null, 'DID'), h('dd', { class: 'mono' }, a.did)),
      ),

      ctx.me.canWrite
        ? h(
            'div',
            { class: 'toolbar' },
            onList
              ? h('button', { type: 'button', class: 'btn', onClick: remove }, 'Take off the list')
              : isProtected
                ? h('p', { class: 'note' }, 'Protected. No path in the bot adds them. If you mean it, block them from your own client.')
                : h('button', { type: 'button', class: 'btn btn-danger', onClick: add }, 'Add to the list'),
          )
        : null,

      h(
        'section',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', null, 'What the log says')),
        a.entries.length
          ? h(
              'ol',
              { class: 'timeline' },
              a.entries.map((e) =>
                h(
                  'li',
                  null,
                  h('div', null, h('strong', null, entryTitle(e)), e.at ? h('span', { class: 'muted' }, `  ${clock(e.at)}`) : null),
                  h(
                    'div',
                    { class: 'toolbar muted' },
                    band(e.band === 'UNSCORED' ? null : e.band),
                    e.action === 'list_add' || e.action === 'list_remove' ? h('span', null, viaWords(e.via)) : null,
                    e.scan
                      ? h('a', { href: `#/scans/${e.code}` }, `Scan ${e.code}`)
                      : h('span', { class: 'mono' }, e.code),
                  ),
                  e.label ? h('div', null, tone(e.label), e.quote ? h('span', { class: 'quote' }, ` “${e.quote}”`) : null) : null,
                  e.words.map((w) => h('div', { class: 'words' }, 'Asked for with: ', h('span', { class: 'mono' }, w))),
                  e.undoneAt ? h('div', { class: 'muted' }, `Taken back ${clock(e.undoneAt)}${e.undoReason ? ` with “${e.undoReason}”` : ''}`) : null,
                ),
              ),
            )
          : h('p', { class: 'muted' }, 'Nothing. The bot has never scanned or acted on this account.'),
      ),
    );
  }

  load();
  return {
    el,
    onClose(fn) {
      close = fn;
    },
  };
}
