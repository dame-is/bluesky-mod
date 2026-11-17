import { describe, it, expect } from 'vitest';
import { ownLinkFacets, postWebUrl, handleInPostUrl } from './links.js';

describe('link facets', () => {
  const uri = 'https://bsky.app/profile/a.test/post/3abc12345';

  it('finds a link it was given and ranges it', () => {
    const text = `Read them: ${uri}`;
    const [facet] = ownLinkFacets(text, { allow: [uri] });
    expect(facet.features[0].uri).toBe(uri);
    expect(facet.index.byteStart).toBe(11);
    expect(facet.index.byteEnd).toBe(11 + uri.length);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // atproto ranges are byte offsets. An emoji or an accented handle earlier
    // in the message shifts every offset after it, and a facet that is off by
    // three bytes underlines the wrong text.
    const text = `🔥 ${uri}`;
    const [facet] = ownLinkFacets(text, { allow: [uri] });
    // The emoji is four bytes, plus one space.
    expect(facet.index.byteStart).toBe(5);
    expect(facet.index.byteEnd - facet.index.byteStart).toBe(uri.length);
  });

  it('ignores links this codebase did not build', () => {
    // The analyst quotes bios and post text. A general linkifier would end up
    // rendering a stranger's URL as tappable in a report about them.
    expect(ownLinkFacets('see https://example.com/evil')).toEqual([]);
    expect(ownLinkFacets(`see ${uri}`)).toEqual([]);
    expect(
      ownLinkFacets('see https://example.com/evil', { allow: [uri] }),
    ).toEqual([]);
  });

  it('finds several in one message', () => {
    expect(ownLinkFacets(`a ${uri} b ${uri}`, { allow: [uri] })).toHaveLength(2);
  });

  it('is empty for a message with no links', () => {
    expect(ownLinkFacets('Added 3 to the list.')).toEqual([]);
    expect(ownLinkFacets('')).toEqual([]);
    expect(ownLinkFacets(null)).toEqual([]);
  });
});

describe('the web URL for a post', () => {
  it('turns an at:// post URI into something a person can open', () => {
    expect(postWebUrl('at://did:plc:abc/app.bsky.feed.post/3xyz')).toBe(
      'https://bsky.app/profile/did:plc:abc/post/3xyz',
    );
  });

  it('refuses anything that is not a post', () => {
    // A broken link is worse than none: it looks like the post is gone when
    // the URL was built wrong.
    expect(postWebUrl('at://did:plc:abc/app.bsky.graph.list/3xyz')).toBe(null);
    expect(postWebUrl('https://bsky.app/profile/x/post/y')).toBe(null);
    expect(postWebUrl('at://did:plc:abc/app.bsky.feed.post/3x y')).toBe(null);
    expect(postWebUrl('at://did:plc:abc/app.bsky.feed.post/..')).toBe(null);
    expect(postWebUrl('at://did:plc:a?b/app.bsky.feed.post/3xyz')).toBe(null);
    expect(postWebUrl('')).toBe(null);
    expect(postWebUrl(null)).toBe(null);
  });
});

describe('post links in a digest', () => {
  const uri = 'at://did:plc:abc/app.bsky.feed.post/3xyz';

  it('names the account when it can, so a link says whose post it is', () => {
    expect(postWebUrl(uri, { handle: 'someone.example.com' })).toBe(
      'https://bsky.app/profile/someone.example.com/post/3xyz',
    );
    expect(handleInPostUrl(postWebUrl(uri, { handle: 'a.test' }))).toBe(
      'a.test',
    );
  });

  it('falls back to the DID rather than rendering a handle it cannot trust', () => {
    // Only a DNS-shaped handle, so nothing with a path separator or a query
    // reaches a tappable URL. The AppView reports a broken handle as
    // handle.invalid, which would be a dead link.
    for (const bad of [
      '../../evil',
      'a/b',
      'no-dot',
      '',
      null,
      'x?y.com',
      'handle.invalid',
    ]) {
      expect(postWebUrl(uri, { handle: bad })).toBe(
        'https://bsky.app/profile/did:plc:abc/post/3xyz',
      );
    }
  });
});

describe('the facet allowlist', () => {
  const ours = 'https://bsky.app/profile/a.test/post/3aaa';
  const theirs = 'https://bsky.app/profile/evil.test/post/3zzz';

  it('facets a post link only when the caller built it', () => {
    // A bsky.app URL this code built looks the same as one the analyst
    // copied out of a stranger's post, so the caller passes the exact set
    // and nothing else matches.
    const text = `see ${ours} and ${theirs}`;
    const facets = ownLinkFacets(text, { allow: [ours] });
    expect(facets).toHaveLength(1);
    expect(facets[0].features[0].uri).toBe(ours);
  });

  it('returns ranges in order and never overlapping', () => {
    // A record with overlapping ranges is one the server may reject.
    const other = 'https://bsky.app/profile/b.test/post/3bbb';
    const text = `${ours} then ${other} then ${ours}`;
    const facets = ownLinkFacets(text, { allow: [ours, other] });
    expect(facets).toHaveLength(3);
    for (let i = 1; i < facets.length; i += 1) {
      expect(facets[i].index.byteStart).toBeGreaterThanOrEqual(
        facets[i - 1].index.byteEnd,
      );
    }
  });

  it('links the longer URL when one allowed URL is a prefix of another', () => {
    const short = 'https://bsky.app/profile/a.test/post/3aa';
    const long = `${short}b`;
    const facets = ownLinkFacets(`see ${long}`, { allow: [short, long] });
    expect(facets).toHaveLength(1);
    expect(facets[0].features[0].uri).toBe(long);
  });

  it('counts offsets in utf-8 bytes, not js indices', () => {
    const text = `🏳️‍⚧️ ${ours}`;
    const [facet] = ownLinkFacets(text, { allow: [ours] });
    const bytes = new TextEncoder().encode(text);
    expect(
      new TextDecoder().decode(
        bytes.slice(facet.index.byteStart, facet.index.byteEnd),
      ),
    ).toBe(ours);
  });
});
