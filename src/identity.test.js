// Handles for the owner and the bot become DIDs before the bot loads, and the
// DID a handle first gave is pinned so a handle that changes hands is caught.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { settleIdentities } from './identity.js';

const OWNER = 'did:plc:owner0000000000000000000';
const STRANGER = 'did:plc:stranger000000000000000';
const BOT = 'did:plc:bot00000000000000000000';

let dataDir;
const answering = (map) => async (url) => {
  const handle = new URL(url).searchParams.get('handle');
  if (map === 'down') throw new Error('fetch failed');
  return map[handle]
    ? { ok: true, status: 200, json: async () => ({ did: map[handle] }) }
    : { ok: false, status: 400, json: async () => ({}) };
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-id-'));
});

describe('settling who the owner and the bot are', () => {
  it('turns handles into DIDs and leaves DIDs alone', async () => {
    const env = { MOD_OWNER_DID: '@me.example.social', MOD_IDENTIFIER: BOT };
    await settleIdentities(env, {
      dataDir,
      fetchImpl: answering({ 'me.example.social': OWNER }),
    });
    expect(env).toEqual({ MOD_OWNER_DID: OWNER, MOD_IDENTIFIER: BOT });
  });

  it('refuses to start when the handle now belongs to someone else', async () => {
    await settleIdentities(
      { MOD_OWNER_DID: 'me.example.social' },
      { dataDir, fetchImpl: answering({ 'me.example.social': OWNER }) },
    );
    await expect(
      settleIdentities(
        { MOD_OWNER_DID: 'me.example.social' },
        { dataDir, fetchImpl: answering({ 'me.example.social': STRANGER }) },
      ),
    ).rejects.toThrow(/now belongs to a different account/);
  });

  it('uses the pinned DID when the lookup cannot be made', async () => {
    await settleIdentities(
      { MOD_OWNER_DID: 'me.example.social' },
      { dataDir, fetchImpl: answering({ 'me.example.social': OWNER }) },
    );
    const env = { MOD_OWNER_DID: 'me.example.social' };
    await settleIdentities(env, { dataDir, fetchImpl: answering('down') });
    expect(env.MOD_OWNER_DID).toBe(OWNER);
  });

  it('says when no account has the handle', async () => {
    await expect(
      settleIdentities(
        { MOD_IDENTIFIER: 'nobody.example.social' },
        { dataDir, fetchImpl: answering({}) },
      ),
    ).rejects.toThrow('MOD_IDENTIFIER is @nobody.example.social, and no account has that handle');
  });
});
