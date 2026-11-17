// The gate writer holds a session that can do anything on the owner's account.
// What matters here is everything it refuses to do with it.

import { describe, it, expect, vi } from 'vitest';
import { createGates, GateRefused } from './gates.js';

const OWNER = 'did:plc:owner0000000000000000000';
const POST = `at://${OWNER}/app.bsky.feed.post/3kpost`;
const TG = 'app.bsky.feed.threadgate';

function agentSpy() {
  const calls = [];
  const fn = (name, impl = async () => ({ data: {} })) =>
    vi.fn(async (args) => {
      calls.push([name, args]);
      return impl(args);
    });
  const agent = {
    com: {
      atproto: {
        repo: {
          listRecords: fn('listRecords', async () => ({ data: { records: [] } })),
          getRecord: fn('getRecord', async () => {
            throw Object.assign(new Error('Could not locate record'), { error: 'RecordNotFound' });
          }),
          applyWrites: fn('applyWrites'),
          putRecord: fn('putRecord'),
          deleteRecord: fn('deleteRecord'),
          createRecord: fn('createRecord'),
        },
      },
    },
    app: { bsky: { feed: { post: fn('post') } } },
  };
  return { agent, calls };
}

const gate = (post = POST) => ({ $type: TG, post, createdAt: '2026-11-17T00:00:00.000Z', allow: [] });

describe('createGates', () => {
  it('hands out methods and nothing else', () => {
    const { agent } = agentSpy();
    const gates = createGates({ getAgent: () => agent, ownerDid: OWNER });
    expect(Object.isFrozen(gates)).toBe(true);
    expect(Object.keys(gates).sort()).toEqual(['post', 'read', 'readAll', 'recentPosts', 'write']);
    for (const v of Object.values(gates)) expect(typeof v).toBe('function');
    expect(JSON.stringify(gates)).toBe('{}');
  });

  it('writes nothing but threadgates and postgates', async () => {
    const { agent, calls } = agentSpy();
    const gates = createGates({ getAgent: () => agent, ownerDid: OWNER });
    for (const kind of ['listitem', 'app.bsky.graph.listitem', 'post', 'block', 'profile']) {
      await expect(gates.read(kind, POST)).rejects.toThrow(GateRefused);
      await expect(gates.write([{ kind, post: POST, value: gate(), existed: false }])).rejects.toThrow(GateRefused);
    }
    expect(calls).toEqual([]);
  });

  it('touches only the owner\'s own posts', async () => {
    const { agent, calls } = agentSpy();
    const gates = createGates({ getAgent: () => agent, ownerDid: OWNER });
    const theirs = 'at://did:plc:someoneelse/app.bsky.feed.post/3kpost';
    await expect(gates.read('threadgate', theirs)).rejects.toThrow(GateRefused);
    await expect(gates.post(theirs)).rejects.toThrow(GateRefused);
    await expect(
      gates.write([{ kind: 'threadgate', post: theirs, value: gate(theirs), existed: false }]),
    ).rejects.toThrow(GateRefused);
    // A list URI in the owner's repo is not a post.
    await expect(gates.read('threadgate', `at://${OWNER}/app.bsky.graph.list/x`)).rejects.toThrow(GateRefused);
    await expect(gates.read('threadgate', `${POST}/../../x`)).rejects.toThrow(GateRefused);
    expect(calls).toEqual([]);
  });

  it('refuses a record that is not the gate it claims to be, or is for another post', async () => {
    const { agent, calls } = agentSpy();
    const gates = createGates({ getAgent: () => agent, ownerDid: OWNER });
    await expect(
      gates.write([{ kind: 'threadgate', post: POST, value: { ...gate(), $type: 'app.bsky.feed.post' }, existed: false }]),
    ).rejects.toThrow(GateRefused);
    await expect(
      gates.write([{ kind: 'threadgate', post: POST, value: gate(`at://${OWNER}/app.bsky.feed.post/other`), existed: false }]),
    ).rejects.toThrow(GateRefused);
    expect(calls).toEqual([]);
  });

  it('writes to the owner\'s repo, as one batch', async () => {
    const { agent, calls } = agentSpy();
    const gates = createGates({ getAgent: () => agent, ownerDid: OWNER });
    await gates.write([
      { kind: 'threadgate', post: POST, value: gate(), existed: false },
      { kind: 'postgate', post: POST, value: null, existed: true },
    ]);
    expect(calls).toHaveLength(1);
    const [name, args] = calls[0];
    expect(name).toBe('applyWrites');
    expect(args.repo).toBe(OWNER);
    expect(args.writes.map((w) => [w.$type.split('#')[1], w.collection, w.rkey])).toEqual([
      ['create', TG, '3kpost'],
      ['delete', 'app.bsky.feed.postgate', '3kpost'],
    ]);
  });

  it('writes one at a time when the batch is refused, and marks failures as the owner\'s', async () => {
    const { agent, calls } = agentSpy();
    agent.com.atproto.repo.applyWrites = vi.fn(async () => {
      throw new Error('record already exists');
    });
    const gates = createGates({ getAgent: () => agent, ownerDid: OWNER });
    await gates.write([{ kind: 'threadgate', post: POST, value: gate(), existed: false }]);
    expect(calls.map(([n]) => n)).toEqual(['putRecord']);

    agent.com.atproto.repo.getRecord = vi.fn(async () => {
      throw Object.assign(new Error('Token has expired'), { status: 400, error: 'ExpiredToken' });
    });
    await expect(gates.read('threadgate', POST)).rejects.toMatchObject({ fromOwner: true });
  });

  it('reads a missing gate as none, and any other failure as a failure', async () => {
    const { agent } = agentSpy();
    const gates = createGates({ getAgent: () => agent, ownerDid: OWNER });
    expect(await gates.read('threadgate', POST)).toBeNull();
    agent.com.atproto.repo.getRecord = vi.fn(async () => {
      throw Object.assign(new Error('Bad request'), { status: 400, error: 'InvalidRequest' });
    });
    await expect(gates.read('threadgate', POST)).rejects.toThrow('Bad request');
  });

  it('says so when the owner session is not connected', async () => {
    const gates = createGates({ getAgent: () => null, ownerDid: OWNER });
    await expect(gates.read('threadgate', POST)).rejects.toThrow(/not connected/);
  });
});
