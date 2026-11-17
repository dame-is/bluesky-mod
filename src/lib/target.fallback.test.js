// resolveHandle asks Slingshot only when the AppView could not answer, never
// when it answered that there is no such handle.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mini = vi.fn();
vi.mock('./slingshot.js', () => ({ resolveMiniDoc: (...a) => mini(...a) }));

const { resolveHandle } = await import('./target.js');

beforeEach(() => mini.mockReset());

describe('resolveHandle when the AppView is down', () => {
  it('takes the DID from Slingshot when the AppView cannot be reached', async () => {
    mini.mockResolvedValue({ did: 'did:plc:fromcache', handle: 'a.test', pds: null });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await resolveHandle('a.test', { fetchImpl })).toBe('did:plc:fromcache');
  });

  it('takes it on a server error too', async () => {
    mini.mockResolvedValue({ did: 'did:plc:fromcache' });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502 }));
    expect(await resolveHandle('a.test', { fetchImpl })).toBe('did:plc:fromcache');
  });

  it('keeps the AppView error when Slingshot cannot answer either', async () => {
    mini.mockResolvedValue(null);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(resolveHandle('a.test', { fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it('does not second-guess "no such handle"', async () => {
    mini.mockResolvedValue({ did: 'did:plc:fromcache' });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400 }));
    await expect(resolveHandle('a.test', { fetchImpl })).rejects.toThrow(/no account found/);
    expect(mini).not.toHaveBeenCalled();
  });
});
