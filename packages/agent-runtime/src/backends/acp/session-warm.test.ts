// Warm-pool lifecycle: put / take / dispose / idle eviction edges.

import { expect, test, afterEach } from 'vitest';
import type { AcpConnection } from './json-rpc.js';
import {
  clearWarmPool,
  disposeSlot,
  putWarmSlot,
  takeWarmSlot,
  warmKey,
  type WarmAgentSlot,
} from './session-warm.ts';

function makeConn(opts?: { exited?: boolean; closeThrows?: boolean }): {
  conn: AcpConnection;
  closeCalls: () => number;
  markExited: () => void;
} {
  let exited = opts?.exited ?? false;
  let closeCalls = 0;
  let resolveExit: (() => void) | undefined;
  const exitedPromise = new Promise<void>((resolve) => {
    if (exited) resolve();
    else resolveExit = resolve;
  });
  const markExited = () => {
    if (exited) return;
    exited = true;
    resolveExit?.();
  };
  const conn: AcpConnection = {
    send: () => undefined,
    request: async <T = unknown>(method: string): Promise<T> => {
      if (method === 'session/close') {
        closeCalls += 1;
        if (opts?.closeThrows) throw new Error('close failed');
      }
      return undefined as T;
    },
    respond: () => undefined,
    respondMethodNotFound: () => undefined,
    setHandlers: () => undefined,
    hasExited: () => exited,
    exited: exitedPromise,
    spawnError: () => undefined,
    stderrTail: () => '',
  };
  return {
    conn,
    closeCalls: () => closeCalls,
    markExited,
  };
}

function makeChild(onKill: () => void): WarmAgentSlot['child'] {
  let killed = false;
  return {
    get killed() {
      return killed;
    },
    stdin: {
      end: () => undefined,
    },
    kill: () => {
      killed = true;
      onKill();
    },
  } as unknown as WarmAgentSlot['child'];
}

afterEach(async () => {
  await clearWarmPool();
});

test('warmKey joins kind/cwd/sessionId', () => {
  expect(warmKey('goose', '/tmp/a', 's1')).toBe('goose\0/tmp/a\0s1');
});

test('takeWarmSlot returns undefined when empty', () => {
  expect(takeWarmSlot('goose', '/tmp', 's1')).toBeUndefined();
});

test('put then take returns a live slot and removes it from the pool', async () => {
  const { conn, markExited } = makeConn();
  const child = makeChild(markExited);
  putWarmSlot({
    kind: 'goose',
    cwd: '/tmp/w',
    sessionId: 'sess-a',
    child,
    conn,
    canResume: true,
    canLoad: false,
    canClose: false,
    httpMcp: true,
    promptCaps: { image: true },
  });
  const slot = takeWarmSlot('goose', '/tmp/w', 'sess-a');
  expect(slot?.sessionId).toBe('sess-a');
  expect(slot?.canResume).toBe(true);
  expect(slot?.httpMcp).toBe(true);
  // Second take misses — slot was claimed.
  expect(takeWarmSlot('goose', '/tmp/w', 'sess-a')).toBeUndefined();
  // Drop the claimed slot so afterEach clearWarmPool isn't needed for it.
  await disposeSlot(slot!);
});

test('takeWarmSlot disposes and returns undefined when process already exited', async () => {
  const { conn, markExited } = makeConn({ exited: true });
  const child = makeChild(markExited);
  putWarmSlot({
    kind: 'acp',
    cwd: '/tmp/x',
    sessionId: 'dead',
    child,
    conn,
    canResume: false,
    canLoad: true,
    canClose: false,
    httpMcp: false,
    promptCaps: {},
  });
  expect(takeWarmSlot('acp', '/tmp/x', 'dead')).toBeUndefined();
});

test('putWarmSlot replaces a previous entry for the same key', async () => {
  const old = makeConn();
  putWarmSlot({
    kind: 'k',
    cwd: '/c',
    sessionId: 's',
    child: makeChild(old.markExited),
    conn: old.conn,
    canResume: false,
    canLoad: false,
    canClose: false,
    httpMcp: false,
    promptCaps: {},
  });
  const next = makeConn();
  putWarmSlot({
    kind: 'k',
    cwd: '/c',
    sessionId: 's',
    child: makeChild(next.markExited),
    conn: next.conn,
    canResume: true,
    canLoad: true,
    canClose: true,
    httpMcp: true,
    promptCaps: {},
  });
  const slot = takeWarmSlot('k', '/c', 's');
  expect(slot?.conn).toBe(next.conn);
  expect(slot?.canResume).toBe(true);
  await disposeSlot(slot!);
});

test('disposeSlot issues session/close when canClose and still live', async () => {
  const { conn, closeCalls, markExited } = makeConn();
  const child = makeChild(markExited);
  await disposeSlot({
    kind: 'g',
    cwd: '/c',
    sessionId: 's-close',
    child,
    conn,
    canResume: false,
    canLoad: false,
    canClose: true,
    httpMcp: false,
    promptCaps: {},
  });
  expect(closeCalls()).toBe(1);
  expect(child.killed).toBe(true);
});

test('disposeSlot ignores close failures and still kills the child', async () => {
  const { conn, markExited } = makeConn({ closeThrows: true });
  const child = makeChild(markExited);
  await disposeSlot({
    kind: 'g',
    cwd: '/c',
    sessionId: 's-close-fail',
    child,
    conn,
    canResume: false,
    canLoad: false,
    canClose: true,
    httpMcp: false,
    promptCaps: {},
  });
  expect(child.killed).toBe(true);
});

test('clearWarmPool empties every slot', async () => {
  const a = makeConn();
  const b = makeConn();
  putWarmSlot({
    kind: 'a',
    cwd: '/1',
    sessionId: 's1',
    child: makeChild(a.markExited),
    conn: a.conn,
    canResume: false,
    canLoad: false,
    canClose: false,
    httpMcp: false,
    promptCaps: {},
  });
  putWarmSlot({
    kind: 'b',
    cwd: '/2',
    sessionId: 's2',
    child: makeChild(b.markExited),
    conn: b.conn,
    canResume: false,
    canLoad: false,
    canClose: false,
    httpMcp: false,
    promptCaps: {},
  });
  await clearWarmPool();
  expect(takeWarmSlot('a', '/1', 's1')).toBeUndefined();
  expect(takeWarmSlot('b', '/2', 's2')).toBeUndefined();
});
