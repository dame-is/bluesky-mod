// resolvePds asks Slingshot only when the DID document cannot be read.
import { describe, it, expect, vi, afterEach } from 'vitest';

const mini = vi.fn();
vi.mock('./slingshot.js', () => ({ resolveMiniDoc: (...a) => mini(...a) }));

const { resolvePds } = await import('./atproto.js');

afterEach(() => {
  vi.unstubAllGlobals();
  mini.mockReset();
});

describe('resolvePds when the directory is down', () => {
  it("takes Slingshot's verified PDS", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    mini.mockResolvedValue({ did: 'did:plc:down1', handle: null, pds: 'https://pds.example' });
    expect(await resolvePds('did:plc:down1')).toBe('https://pds.example');
  });

  it("keeps the directory's error when Slingshot has nothing", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, statusText: 'x', text: async () => '' })));
    mini.mockResolvedValue(null);
    await expect(resolvePds('did:plc:down2')).rejects.toThrow(/HTTP 503/);
  });

  it('never asks Slingshot when the document answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://home.example/' }] }),
      })),
    );
    expect(await resolvePds('did:plc:up1')).toBe('https://home.example');
    expect(mini).not.toHaveBeenCalled();
  });
});
