// governance: allow-repo-hygiene file-size-limit cohesive bridge regression suite; splitting is outside issue #417
// Bridge-script behavior (issue #404). The change bridge ships as a serialized
// inline `<script>`; these load that exact string into a `vm` sandbox with a
// mocked `fetch` and drive `window.centraid.read/write` to prove the new
// in-flight dedup + AbortController semantics — not just that the source string
// contains the API.

import { runInNewContext } from 'node:vm';
import { afterEach, expect, test, vi } from 'vitest';
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
    subscribe: (listener: (value: unknown) => void) => () => void;
  };
  write: (opts: {
    action: string;
    input?: unknown;
    signal?: AbortSignal;
    optimistic?: unknown[];
    onlineOnly?: boolean;
    intentId?: string;
  }) => Promise<unknown>;
  onChange: (listener: (detail: unknown) => void) => () => void;
  describe: (filter?: Record<string, unknown>) => Promise<unknown>;
}

interface TestPort {
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
  close(): void;
  onmessage?: (event: { data: unknown }) => void;
}

function testMessageChannel(): { parent: TestPort; child: TestPort } {
  const listeners = new WeakMap<TestPort, Array<(event: { data: unknown }) => void>>();
  const closed = new WeakSet<TestPort>();
  let parent: TestPort;
  let child: TestPort;
  const make = (peer: () => TestPort): TestPort => {
    const port: TestPort = {
      postMessage(data) {
        const target = peer();
        if (closed.has(port) || closed.has(target)) return;
        const event = { data };
        for (const listener of listeners.get(target) ?? []) listener(event);
        target.onmessage?.(event);
      },
      addEventListener(_type, listener) {
        const values = listeners.get(port) ?? [];
        values.push(listener);
        listeners.set(port, values);
      },
      start() {},
      close() {
        closed.add(port);
      },
    };
    return port;
  };
  parent = make(() => child);
  child = make(() => parent);
  return { parent, child };
}

afterEach(() => vi.useRealTimers());

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

function loadChangeHandshake(autoAcknowledge: boolean): {
  centraid: Centraid;
  eventSources: Array<{ url: string; closed: boolean }>;
  parentPosts: unknown[];
  sendFromParent: (data: unknown) => void;
} {
  const src = changeBridgeScript()
    .replace(/^<script>/, '')
    .replace(/<\/script>$/, '');
  const parentPosts: unknown[] = [];
  const messageListeners: Array<
    (event: { source: unknown; data: unknown; ports?: TestPort[] }) => void
  > = [];
  let parentPort: TestPort | undefined;
  let changesRequested = false;
  const eventSources: Array<{
    url: string;
    closed: boolean;
    handlers: Map<string, (event: unknown) => void>;
  }> = [];
  const parent = {
    postMessage(data: unknown): void {
      parentPosts.push(data);
      const message = data as { type?: unknown; documentNonce?: unknown } | undefined;
      if (message?.type === 'centraid:changes-ready') changesRequested = true;
      if (autoAcknowledge && message?.type === 'centraid:replica-ready') {
        const channel = testMessageChannel();
        parentPort = channel.parent;
        for (const listener of messageListeners) {
          listener({
            source: parent,
            data: { type: 'centraid:replica-parent', documentNonce: message.documentNonce },
            ports: [channel.child],
          });
        }
        if (changesRequested) parentPort.postMessage({ type: 'centraid:changes-parent' }, []);
      }
    },
  };
  class FakeEventSource {
    readyState = 1;
    private readonly record: (typeof eventSources)[number];
    constructor(url: string) {
      this.record = { url, closed: false, handlers: new Map() };
      eventSources.push(this.record);
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.record.handlers.set(type, listener);
    }
    close(): void {
      this.record.closed = true;
      this.readyState = 2;
    }
  }
  const win: Record<string, unknown> = {
    parent,
    location: { pathname: '/centraid/demo/index.html' },
    addEventListener(
      type: string,
      listener: (event: { source: unknown; data: unknown; ports?: TestPort[] }) => void,
    ) {
      if (type === 'message') messageListeners.push(listener);
    },
    dispatchEvent: () => undefined,
  };
  runInNewContext(src, {
    window: win,
    document: { hidden: false, addEventListener: () => undefined },
    EventSource: FakeEventSource,
    fetch: () => Promise.reject(new Error('unused')),
    AbortController,
    Promise,
    JSON,
    Object,
    Error,
    Math,
    setTimeout,
    clearTimeout,
  });
  return {
    centraid: win.centraid as Centraid,
    eventSources,
    parentPosts,
    sendFromParent: (data) => {
      if (!parentPort) {
        const channel = testMessageChannel();
        parentPort = channel.parent;
        for (const listener of messageListeners) {
          listener({
            source: parent,
            data: { type: 'centraid:replica-parent', documentNonce: null },
            ports: [channel.child],
          });
        }
      }
      parentPort.postMessage(data, []);
    },
  };
}

test('a parent handshake suppresses the per-app EventSource and delivers vault changes', () => {
  vi.useFakeTimers();
  const bridge = loadChangeHandshake(true);
  const received: unknown[] = [];
  bridge.centraid.onChange((detail) => received.push(detail));

  expect(bridge.parentPosts).toEqual([
    { type: 'centraid:changes-ready', appId: 'demo', documentNonce: null },
    { type: 'centraid:replica-ready', appId: 'demo', documentNonce: null },
  ]);
  vi.advanceTimersByTime(2_000);
  expect(bridge.eventSources).toHaveLength(0);

  bridge.sendFromParent({
    type: 'centraid:vault-change',
    detail: {
      cursor: { epoch: 'epoch-a', seq: 7 },
      entity: 'task',
      rowId: 'task-1',
      op: 'update',
      changedAt: '2026-07-15T08:00:00.000Z',
    },
  });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    entity: 'task',
    rowId: 'task-1',
    tables: ['task'],
    source: 'vault-replica',
  });
});

test('a managed iframe with no acknowledgement falls back, and a late acknowledgement closes it', () => {
  vi.useFakeTimers();
  const bridge = loadChangeHandshake(false);

  vi.advanceTimersByTime(499);
  expect(bridge.eventSources).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(bridge.eventSources).toMatchObject([{ url: '_changes', closed: false }]);

  bridge.sendFromParent({ type: 'centraid:changes-parent' });
  expect(bridge.eventSources[0]!.closed).toBe(true);
  vi.advanceTimersByTime(30_000);
  expect(bridge.eventSources).toHaveLength(1);
});

function loadReplicaBridge(
  handler: (args: {
    input: unknown;
    ctx: {
      vault: {
        read: (request: unknown) => Promise<unknown>;
        search: (request: unknown) => Promise<unknown>;
      };
    };
  }) => Promise<unknown>,
): {
  centraid: Centraid;
  fetches: Array<{ url: string; body: Record<string, unknown> }>;
  parentPosts: Array<Record<string, unknown>>;
  setRows(rows: unknown[]): void;
  setReplicaError(error?: { code: string; message: string }): void;
  setFetchError(error?: Error): void;
  sendFromParent(data: unknown): void;
} {
  const src = changeBridgeScript()
    .replace(/^<script>/, '')
    .replace(/<\/script>$/, '');
  const messageListeners: Array<
    (event: { source: unknown; data: unknown; ports?: TestPort[] }) => void
  > = [];
  const parentPosts: Array<Record<string, unknown>> = [];
  const fetches: Array<{ url: string; body: Record<string, unknown> }> = [];
  let rows: unknown[] = [
    {
      rowId: 'task-1',
      values: { task_id: 'task-1', title: 'Local' },
      oversizedFields: [],
      hasUnavailableFields: false,
    },
  ];
  let replicaError: { code: string; message: string } | undefined;
  let fetchError: Error | undefined;
  let parentPort: TestPort | undefined;
  let changesRequested = false;
  const reply = (payload: unknown): void => parentPort?.postMessage(payload);
  const handlePortMessage = (data: Record<string, unknown>): void => {
    parentPosts.push(data);
    if (data.type === 'centraid:replica-read' || data.type === 'centraid:replica-search') {
      if (replicaError) {
        reply({
          type: 'centraid:replica-result',
          id: data.id,
          ok: false,
          code: replicaError.code,
          error: replicaError.message,
        });
        return;
      }
      reply({
        type: 'centraid:replica-result',
        id: data.id,
        ok: true,
        result: {
          rows,
          cursor: { epoch: 'epoch-a', seq: 2 },
          dependency: { shapeId: 'agenda:shape', entity: 'schedule.task' },
        },
      });
    } else if (data.type === 'centraid:replica-write') {
      if (replicaError) {
        reply({
          type: 'centraid:replica-result',
          id: data.id,
          ok: false,
          code: replicaError.code,
          error: replicaError.message,
        });
        return;
      }
      reply({
        type: 'centraid:replica-result',
        id: data.id,
        ok: true,
        result: { status: 'queued', intentId: 'intent-1' },
      });
    }
  };
  const parent = {
    postMessage(data: Record<string, unknown>): void {
      parentPosts.push(data);
      if (data.type === 'centraid:changes-ready') changesRequested = true;
      else if (data.type === 'centraid:replica-ready') {
        const channel = testMessageChannel();
        parentPort = channel.parent;
        parentPort.addEventListener('message', (event) =>
          handlePortMessage(event.data as Record<string, unknown>),
        );
        for (const listener of messageListeners) {
          listener({
            source: parent,
            data: { type: 'centraid:replica-parent', documentNonce: data.documentNonce },
            ports: [channel.child],
          });
        }
        if (changesRequested) reply({ type: 'centraid:changes-parent' });
      }
    },
  };
  const win: Record<string, unknown> = {
    parent,
    centraid: { __loadQuery: () => Promise.resolve({ default: handler }) },
    location: {
      href: 'https://gateway.test/centraid/demo/index.html',
      pathname: '/centraid/demo/index.html',
    },
    addEventListener(
      type: string,
      listener: (event: { source: unknown; data: unknown; ports?: TestPort[] }) => void,
    ) {
      if (type === 'message') messageListeners.push(listener);
    },
    dispatchEvent: () => undefined,
  };
  runInNewContext(src, {
    window: win,
    document: { hidden: false, addEventListener: () => undefined },
    EventSource: undefined,
    fetch: async (url: string, init: { body: string }) => {
      fetches.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      if (fetchError) throw fetchError;
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ source: 'server' })),
      };
    },
    AbortController,
    Promise,
    JSON,
    Object,
    Error,
    Math,
    URL,
    setTimeout,
    clearTimeout,
  });
  return {
    centraid: win.centraid as Centraid,
    fetches,
    parentPosts,
    setRows(next) {
      rows = next;
    },
    setReplicaError(next) {
      replicaError = next;
    },
    setFetchError(next) {
      fetchError = next;
    },
    sendFromParent(data) {
      reply(data);
    },
  };
}

test('managed reads execute the declared query in-frame against clone-safe replica rows', async () => {
  const bridge = loadReplicaBridge(async ({ ctx }) => {
    const result = (await ctx.vault.read({ entity: 'schedule.task' })) as {
      rows: Array<{ title: string }>;
    };
    return { titles: result.rows.map((row) => row.title) };
  });
  await expect(bridge.centraid.read({ query: 'board' })).resolves.toEqual({ titles: ['Local'] });
  expect(bridge.fetches).toHaveLength(0);
  expect(bridge.parentPosts).toContainEqual(
    expect.objectContaining({ type: 'centraid:replica-read', appId: 'demo' }),
  );
});

test('managed searches stay local and retain their replica receipt and dependency', async () => {
  const bridge = loadReplicaBridge(async ({ ctx }) => {
    const result = (await ctx.vault.search({
      entity: 'schedule.task',
      query: 'local',
      limit: 100,
    })) as {
      rows: Array<{ title: string }>;
      receiptId: string;
      dependency: { shapeId: string; entity: string };
    };
    return {
      titles: result.rows.map((row) => row.title),
      receiptId: result.receiptId,
      dependency: result.dependency,
    };
  });

  await expect(
    bridge.centraid.read({ query: 'search', input: { query: 'local' } }),
  ).resolves.toEqual({
    titles: ['Local'],
    receiptId: 'replica:epoch-a:2',
    dependency: { shapeId: 'agenda:shape', entity: 'schedule.task' },
  });
  expect(bridge.fetches).toHaveLength(0);
  expect(bridge.parentPosts).toContainEqual(
    expect.objectContaining({
      type: 'centraid:replica-search',
      appId: 'demo',
      request: { entity: 'schedule.task', query: 'local', limit: 100 },
    }),
  );
});

test('a caught sealed-field access stays sticky and transparently reruns server-side', async () => {
  const bridge = loadReplicaBridge(async ({ ctx }) => {
    try {
      const result = (await ctx.vault.read({ entity: 'locker.item' })) as {
        rows: Array<{ password?: string }>;
      };
      return { password: result.rows[0]?.password };
    } catch {
      return { swallowed: true };
    }
  });
  bridge.setRows([
    {
      rowId: 'item-1',
      values: { item_id: 'item-1', title: 'Login' },
      oversizedFields: [],
      hasUnavailableFields: true,
    },
  ]);
  await expect(bridge.centraid.read({ query: 'items' })).resolves.toEqual({ source: 'server' });
  expect(bridge.fetches).toHaveLength(1);
});

test('a local query bug is surfaced instead of being masked by an online rerun', async () => {
  const bridge = loadReplicaBridge(async () => {
    throw Object.assign(new Error('query implementation broke'), { code: 'QUERY_BUNDLE_INVALID' });
  });

  await expect(bridge.centraid.read({ query: 'items' })).rejects.toThrow(
    'query implementation broke',
  );
  expect(bridge.fetches).toHaveLength(0);
});

test('a replica protocol error is surfaced instead of changing execution modes', async () => {
  const bridge = loadReplicaBridge(async ({ ctx }) => ctx.vault.read({ entity: 'schedule.task' }));
  bridge.setReplicaError({
    code: 'REPLICA_PROTOCOL_ERROR',
    message: 'local schema contract was violated',
  });

  await expect(bridge.centraid.read({ query: 'items' })).rejects.toThrow(
    'local schema contract was violated',
  );
  expect(bridge.fetches).toHaveLength(0);
});

test('read subscriptions deliver rerun data after a relevant replica invalidation', async () => {
  const bridge = loadReplicaBridge(async ({ ctx }) => {
    const result = (await ctx.vault.read({ entity: 'schedule.task' })) as {
      rows: Array<{ title: string }>;
    };
    return result.rows.map((row) => row.title);
  });
  const values: unknown[] = [];
  const pending = bridge.centraid.read({ query: 'board' });
  const unsubscribe = pending.subscribe((value) => values.push(value));
  await pending;
  await flush();
  const subscription = bridge.parentPosts.find(
    (message) => message.type === 'centraid:replica-subscribe',
  );
  expect(subscription).toBeDefined();

  bridge.setRows([
    {
      rowId: 'task-1',
      values: { task_id: 'task-1', title: 'Updated' },
      oversizedFields: [],
      hasUnavailableFields: false,
    },
  ]);
  bridge.sendFromParent({
    type: 'centraid:replica-invalidate',
    subscriptionId: subscription?.subscriptionId,
    invalidations: [{ shapeId: 'agenda:shape', entity: 'schedule.task' }],
  });
  await flush();
  await flush();
  expect(values).toEqual([['Local'], ['Updated']]);
  unsubscribe();
  expect(bridge.parentPosts).toContainEqual(
    expect.objectContaining({ type: 'centraid:replica-unsubscribe' }),
  );
});

test('a live query re-localizes after rebootstrap restores the replica', async () => {
  const bridge = loadReplicaBridge(async ({ ctx }) => {
    const result = (await ctx.vault.read({ entity: 'schedule.task' })) as {
      rows: Array<{ title: string }>;
    };
    return result.rows.map((row) => row.title);
  });
  const values: unknown[] = [];
  const pending = bridge.centraid.read({ query: 'board' });
  const unsubscribe = pending.subscribe((value) => values.push(value));
  await pending;
  await flush();
  const firstSubscription = bridge.parentPosts.find(
    (message) => message.type === 'centraid:replica-subscribe',
  );
  expect(firstSubscription).toBeDefined();

  bridge.setReplicaError({
    code: 'REPLICA_REBOOTSTRAP_REQUIRED',
    message: 'replica is rebuilding',
  });
  bridge.sendFromParent({
    type: 'centraid:replica-invalidate',
    subscriptionId: firstSubscription?.subscriptionId,
    invalidations: [{ shapeId: 'agenda:shape', entity: 'schedule.task', source: 'purge' }],
  });
  await flush();
  await flush();
  expect(values).toEqual([['Local'], { source: 'server' }]);
  expect(bridge.parentPosts).toContainEqual(
    expect.objectContaining({ type: 'centraid:replica-unsubscribe' }),
  );

  bridge.setReplicaError();
  bridge.setRows([
    {
      rowId: 'task-1',
      values: { task_id: 'task-1', title: 'Rebootstrapped' },
      oversizedFields: [],
      hasUnavailableFields: false,
    },
  ]);
  bridge.sendFromParent({
    type: 'centraid:vault-rebootstrap',
    detail: { reason: 'bootstrap-complete' },
  });
  await flush();
  await flush();

  expect(values).toEqual([['Local'], { source: 'server' }, ['Rebootstrapped']]);
  expect(
    bridge.parentPosts.filter((message) => message.type === 'centraid:replica-subscribe'),
  ).toHaveLength(2);
  unsubscribe();
});

test('managed writes enter the shell intent queue with optimistic mutations', async () => {
  const bridge = loadReplicaBridge(async () => null);
  await expect(
    bridge.centraid.write({
      action: 'complete',
      input: { task_id: 'task-1' },
      optimistic: [
        { op: 'upsert', entity: 'schedule.task', rowId: 'task-1', values: { status: 'done' } },
      ],
    }),
  ).resolves.toEqual({ status: 'queued', intentId: 'intent-1' });
  expect(bridge.parentPosts).toContainEqual(
    expect.objectContaining({
      type: 'centraid:replica-write',
      action: 'complete',
      optimistic: [expect.objectContaining({ entity: 'schedule.task' })],
    }),
  );
});

test('replica-unavailable write fallback preserves its idempotency key', async () => {
  const bridge = loadReplicaBridge(async () => null);
  bridge.setReplicaError({ code: 'REPLICA_UNAVAILABLE', message: 'admission timed out' });

  await expect(
    bridge.centraid.write({
      action: 'complete',
      input: { task_id: 'task-1' },
      intentId: 'intent-timeout-1',
    }),
  ).resolves.toEqual({ source: 'server' });
  expect(bridge.fetches).toContainEqual({
    url: '/centraid/_tool/centraid_write',
    body: {
      app: 'demo',
      action: 'complete',
      input: { task_id: 'task-1' },
      intentId: 'intent-timeout-1',
    },
  });
});

test('managed online-only writes fail with the network and never enter the shell intent queue', async () => {
  const bridge = loadReplicaBridge(async () => null);
  bridge.setFetchError(new Error('offline'));

  await expect(
    bridge.centraid.write({
      action: 'add-item',
      input: { title: 'Email', password: 'do-not-persist' },
      onlineOnly: true,
    }),
  ).rejects.toThrow('offline');

  expect(bridge.fetches).toContainEqual({
    url: '/centraid/_tool/centraid_write',
    body: {
      app: 'demo',
      action: 'add-item',
      input: { title: 'Email', password: 'do-not-persist' },
    },
  });
  expect(bridge.parentPosts).not.toContainEqual(
    expect.objectContaining({ type: 'centraid:replica-write' }),
  );
});

test('a remembered opaque app prewarms every declared query without evaluating it or leaking failures', async () => {
  const src = changeBridgeScript()
    .replace(/^<script>/, '')
    .replace(/<\/script>$/, '');
  const messageListeners: Array<
    (event: { source: unknown; data: unknown; ports?: TestPort[] }) => void
  > = [];
  const resources: Array<Record<string, unknown>> = [];
  let parentPort: TestPort | undefined;
  const parent = {
    postMessage(data: Record<string, unknown>): void {
      if (data.type !== 'centraid:replica-ready') return;
      const channel = testMessageChannel();
      parentPort = channel.parent;
      parentPort.addEventListener('message', (event) => {
        const message = event.data as Record<string, unknown>;
        if (message.type !== 'centraid:resource') return;
        resources.push(message);
        const request = message.request as { url: string; method: string };
        if (request.url.endsWith('/_query/search.mjs')) {
          // One broken bundle must neither reject globally nor prevent the
          // other declared modules from warming.
          parentPort?.postMessage({
            type: 'centraid:replica-result',
            id: message.id,
            ok: false,
            code: 'APP_RESOURCE_UNAVAILABLE',
            error: 'query bundle unavailable',
          });
          return;
        }
        const payload = request.url.endsWith('/app.json')
          ? {
              manifestVersion: 1,
              id: 'demo',
              queries: [
                { name: 'upcoming' },
                { name: 'search' },
                { name: 'upcoming' },
                { name: '../not-a-query' },
              ],
            }
          : request.url.includes('/_query/')
            ? 'export default async function(){}'
            : { source: 'tool-over-port' };
        const body = new TextEncoder().encode(
          typeof payload === 'string' ? payload : JSON.stringify(payload),
        ).buffer;
        parentPort?.postMessage({
          type: 'centraid:replica-result',
          id: message.id,
          ok: true,
          result: {
            url: request.url,
            status: 200,
            statusText: 'OK',
            headers: [
              [
                'content-type',
                request.url.includes('/_query/') ? 'application/javascript' : 'application/json',
              ],
            ],
            body,
          },
        });
      });
      for (const listener of messageListeners) {
        listener({
          source: parent,
          data: { type: 'centraid:replica-parent', documentNonce: 'document-one' },
          ports: [channel.child],
        });
      }
    },
  };
  const nativeFetch = vi.fn(() => Promise.reject(new Error('opaque fetch escaped to network')));
  const win: Record<string, unknown> = {
    parent,
    centraid: {
      appId: 'demo',
      documentNonce: 'document-one',
      opaqueBaseUrl: 'https://shell.test/__centraid_iroh__/d-device/centraid/demo/',
    },
    fetch: nativeFetch,
    location: { href: 'data:text/html,opaque', pathname: '', hash: '' },
    addEventListener(
      type: string,
      listener: (event: { source: unknown; data: unknown; ports?: TestPort[] }) => void,
    ) {
      if (type === 'message') messageListeners.push(listener);
    },
    dispatchEvent: () => undefined,
  };
  runInNewContext(src, {
    window: win,
    document: { hidden: false, addEventListener: () => undefined },
    EventSource: undefined,
    fetch: nativeFetch,
    AbortController,
    Request,
    Response,
    Blob,
    ArrayBuffer,
    TextEncoder,
    Promise,
    JSON,
    Object,
    Error,
    Math,
    URL,
    setTimeout,
    clearTimeout,
  });

  await expect((win.centraid as Centraid).describe()).resolves.toEqual({
    source: 'tool-over-port',
  });
  await flush();
  await flush();
  expect(nativeFetch).not.toHaveBeenCalled();
  const requests = resources.map((resource) => resource.request as { url: string; method: string });
  expect(requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: 'https://shell.test/__centraid_iroh__/d-device/centraid/demo/app.json',
        method: 'GET',
      }),
      expect.objectContaining({
        url: 'https://shell.test/__centraid_iroh__/d-device/centraid/demo/_query/upcoming.mjs',
        method: 'GET',
      }),
      expect.objectContaining({
        url: 'https://shell.test/__centraid_iroh__/d-device/centraid/demo/_query/search.mjs',
        method: 'GET',
      }),
      expect.objectContaining({
        url: 'https://shell.test/__centraid_iroh__/d-device/centraid/_tool/centraid_describe',
        method: 'POST',
      }),
    ]),
  );
  expect(requests.filter((request) => request.url.endsWith('/_query/upcoming.mjs'))).toHaveLength(
    1,
  );
  expect(requests.some((request) => request.url.includes('not-a-query'))).toBe(false);
});
