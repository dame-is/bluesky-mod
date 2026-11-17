import { describe, it, expect, vi } from 'vitest';
import { resolveMiniDoc, slingshotEnabled } from './slingshot.js';

const BASE = 'https://slingshot.test';
const answer = (body, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));

describe('resolveMiniDoc', () => {
  it('is off in tests unless a base is given', async () => {
    expect(slingshotEnabled()).toBe(false);
    const fetchImpl = answer({ did: 'did:plc:abc' });
    expect(await resolveMiniDoc('a.test', { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers did, handle and pds', async () => {
    const fetchImpl = answer({ did: 'did:plc:abc', handle: 'a.test', pds: 'https://pds.test/' });
    expect(await resolveMiniDoc('a.test', { fetchImpl, base: BASE })).toEqual({
      did: 'did:plc:abc',
      handle: 'a.test',
      pds: 'https://pds.test',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${BASE}/xrpc/blue.microcosm.identity.resolveMiniDoc?identifier=a.test`,
    );
  });

  it('refuses an answer about another DID, a non-DID, or a pds that is not https', async () => {
    expect(
      await resolveMiniDoc('did:plc:abc', { fetchImpl: answer({ did: 'did:plc:other' }), base: BASE }),
    ).toBeNull();
    expect(await resolveMiniDoc('a.test', { fetchImpl: answer({ did: 'nope' }), base: BASE })).toBeNull();
    expect(
      (await resolveMiniDoc('a.test', { fetchImpl: answer({ did: 'did:plc:abc', pds: 'http://x' }), base: BASE }))
        .pds,
    ).toBeNull();
  });

  it('is null on an error status or a failed request', async () => {
    expect(await resolveMiniDoc('a.test', { fetchImpl: answer({}, false), base: BASE })).toBeNull();
    const boom = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await resolveMiniDoc('a.test', { fetchImpl: boom, base: BASE })).toBeNull();
  });
});
