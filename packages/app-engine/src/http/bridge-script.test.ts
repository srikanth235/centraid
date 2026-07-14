// Bridge-script behavior (issue #404). The change bridge ships as a serialized
// inline `<script>`; these load that exact string into a `vm` sandbox with a
// mocked `fetch` and drive `window.centraid.read/write` to prove the new
// in-flight dedup + AbortController semantics — not just that the source string
// contains the API.

import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { changeBridgeScript } from './bridge-script.js';

interface FetchCall {
  url: string;
  init: { method: string; body: string; signal?: AbortSignal };
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface Centraid {
  read: (opts: { query: string; input?: unknown; signal?: AbortSignal }) => Promise<unknown> & {
    abort: () => void;
  };
  write: (opts: { action: string; input?: unknown; signal?: AbortSignal }) => Promise<unknown>;
}

/** Load the bridge into a sandbox; returns the wired `centraid` API + fetch log. */
function loadBridge(): { centraid: Centraid; calls: FetchCall[] } {
  const src = changeBridgeScript()
    .replace(/^<script>/, '')
    .replace(/<\/script>$/, '');
  const calls: FetchCall[] = [];
  const fetchMock = (url: string, init: FetchCall['init']): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      calls.push({
        url,
        init,
        // Resolve with a Response-like object the bridge can `.text()`.
        resolve: (value: unknown) =>
          resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(value)) }),
        reject,
      });
    });
  };
  const win: Record<string, unknown> = {
    location: { pathname: '/centraid/demo/index.html' },
    addEventListener: () => undefined,
    dispatchEvent: () => undefined,
  };
  const ctx: Record<string, unknown> = {
    window: win,
    document: { hidden: false, addEventListener: () => undefined },
    // Undefined so the SSE block early-returns — this suite only cares about
    // the three-tool helpers, which are defined before that guard.
    EventSource: undefined,
    fetch: fetchMock,
    AbortController,
    Promise,
    JSON,
    Object,
    Error,
    Math,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(src, ctx);
  return { centraid: win.centraid as Centraid, calls };
}

/** Flush pending microtasks so dedup-map cleanup (`.then`) settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('concurrent identical reads share one fetch and one result', async () => {
  const { centraid, calls } = loadBridge();
  const p1 = centraid.read({ query: 'list', input: { page: 1 } });
  const p2 = centraid.read({ query: 'list', input: { page: 1 } });
  expect(calls.length).toBe(1);
  calls[0]!.resolve({ rows: [1, 2, 3] });
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toEqual({ rows: [1, 2, 3] });
  expect(r2).toEqual({ rows: [1, 2, 3] });
});

test('reads with different input are not deduped', async () => {
  const { centraid, calls } = loadBridge();
  void centraid.read({ query: 'list', input: { page: 1 } });
  void centraid.read({ query: 'list', input: { page: 2 } });
  expect(calls.length).toBe(2);
});

test('a fresh read after the shared one settles issues a new fetch', async () => {
  const { centraid, calls } = loadBridge();
  const p1 = centraid.read({ query: 'list', input: {} });
  expect(calls.length).toBe(1);
  calls[0]!.resolve({ rows: [] });
  await p1;
  await flush(); // dedup entry cleared on the settle microtask
  void centraid.read({ query: 'list', input: {} });
  expect(calls.length).toBe(2);
});

test('write is never deduped', async () => {
  const { centraid, calls } = loadBridge();
  void centraid.write({ action: 'add', input: { x: 1 } });
  void centraid.write({ action: 'add', input: { x: 1 } });
  expect(calls.length).toBe(2);
});

test('write passes its signal through to fetch', async () => {
  const { centraid, calls } = loadBridge();
  const ac = new AbortController();
  void centraid.write({ action: 'add', input: {}, signal: ac.signal });
  expect(calls[0]!.init.signal).toBe(ac.signal);
});

test('aborting one sharer rejects only that caller; the shared fetch continues', async () => {
  const { centraid, calls } = loadBridge();
  const ac = new AbortController();
  const aborter = centraid.read({ query: 'list', input: {}, signal: ac.signal });
  const other = centraid.read({ query: 'list', input: {} });
  expect(calls.length).toBe(1);

  ac.abort();
  await expect(aborter).rejects.toMatchObject({ name: 'AbortError' });
  // Only one of two sharers aborted → the underlying fetch signal is untouched.
  expect(calls[0]!.init.signal!.aborted).toBe(false);

  calls[0]!.resolve({ rows: ['still here'] });
  await expect(other).resolves.toEqual({ rows: ['still here'] });
});

test('when every sharer aborts, the underlying fetch is aborted', async () => {
  const { centraid, calls } = loadBridge();
  const a1 = new AbortController();
  const a2 = new AbortController();
  const p1 = centraid.read({ query: 'list', input: {}, signal: a1.signal });
  const p2 = centraid.read({ query: 'list', input: {}, signal: a2.signal });
  expect(calls.length).toBe(1);

  a1.abort();
  a2.abort();
  await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
  await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls[0]!.init.signal!.aborted).toBe(true);
});

test('the returned promise exposes .abort() for callers without a signal', async () => {
  const { centraid, calls } = loadBridge();
  const p = centraid.read({ query: 'list', input: {} });
  expect(typeof p.abort).toBe('function');
  p.abort();
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  // Sole sharer aborted → shared fetch cancelled.
  expect(calls[0]!.init.signal!.aborted).toBe(true);
});

test('an already-aborted signal rejects the read immediately', async () => {
  const { centraid, calls } = loadBridge();
  const ac = new AbortController();
  ac.abort();
  const p = centraid.read({ query: 'list', input: {}, signal: ac.signal });
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls[0]!.init.signal!.aborted).toBe(true);
});
