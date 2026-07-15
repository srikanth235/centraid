import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  auth: vi.fn(),
  doFetch: vi.fn(),
}));

vi.mock('./gateway-client-core.js', () => ({
  auth: core.auth,
  doFetch: core.doFetch,
  authHeaders: (token: string | undefined) => (token ? { Authorization: `Bearer ${token}` } : {}),
}));

let feedModule: typeof import('./vault-change-feed.js');

beforeAll(async () => {
  (window as unknown as { CentraidApi: unknown }).CentraidApi = {
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
  };
  feedModule = await import('./vault-change-feed.js');
});

beforeEach(async () => {
  core.auth.mockReset();
  core.doFetch.mockReset();
  core.auth.mockResolvedValue({
    baseUrl: 'https://gateway.test',
    token: 'secret',
    vaultId: 'vault-a',
  });
  window.sessionStorage.clear();
  await feedModule.setVaultChangeShapeIds(undefined);
});

afterAll(() => vi.useRealTimers());

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function controlledBody(): {
  body: ReadableStream<Uint8Array>;
  enqueue: (chunk: string) => void;
  close: () => void;
  wasCancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  return {
    body: new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
      cancel() {
        cancelled = true;
      },
    }),
    enqueue: (chunk) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
    wasCancelled: () => cancelled,
  };
}

describe('consumeVaultChangeSse', () => {
  it('parses split CRLF frames, comments, ids, and multi-line data', async () => {
    const stream = controlledBody();
    const frames: import('./vault-change-feed.js').SseFrame[] = [];
    const done = feedModule.consumeVaultChangeSse(stream.body, (frame) => frames.push(frame));

    stream.enqueue(': heartbeat\r\nevent: change\r\nid: 9\r\ndata: {"entity":"task",\r');
    stream.enqueue('\ndata: "rowId":"one"}\r\n\r');
    stream.enqueue('\nevent: cursor\ndata: {"epoch":"e1","seq":9}\n\n');
    stream.close();
    await done;

    expect(frames).toEqual([
      {
        event: 'change',
        id: '9',
        data: '{"entity":"task",\n"rowId":"one"}',
      },
      { event: 'cursor', data: '{"epoch":"e1","seq":9}' },
    ]);
  });
});

describe('subscribeVaultChanges', () => {
  it('keeps one cursor namespace when a stable gateway is re-dialed at another URL', async () => {
    core.auth.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:41001',
      gatewayId: 'profile-home',
      vaultId: 'vault-a',
    });
    await feedModule.resumeVaultChanges({ epoch: 'stable', seq: 4 });
    core.auth.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:51002',
      gatewayId: 'profile-home',
      vaultId: 'vault-a',
    });
    await feedModule.resumeVaultChanges({ epoch: 'stable', seq: 5 });

    expect(window.sessionStorage).toHaveLength(1);
    expect(window.sessionStorage.getItem(window.sessionStorage.key(0)!)).toBe(
      JSON.stringify({ epoch: 'stable', seq: 5 }),
    );
  });

  it('attests the scoped persisted shape catalog on the active stream and reconnect URL', async () => {
    const unattested = controlledBody();
    const attested = controlledBody();
    core.doFetch
      .mockResolvedValueOnce({ ok: true, status: 200, body: unattested.body })
      .mockResolvedValueOnce({ ok: true, status: 200, body: attested.body });
    const off = feedModule.subscribeVaultChanges(() => undefined);
    await flush();

    expect(core.doFetch.mock.calls[0]?.[1]).toBe('/centraid/_vault/changes?since=0%3A0&stream=1');
    await feedModule.setVaultChangeShapeIds(['shape-z', 'shape-a', 'shape-z']);
    await flush();

    expect(unattested.wasCancelled()).toBe(true);
    expect(core.doFetch.mock.calls[1]?.[1]).toBe(
      '/centraid/_vault/changes?since=0%3A0&stream=1&shapeIds=shape-a%2Cshape-z',
    );

    off();
  });

  it('ignores a late response from the stream generation replaced by shape attestation', async () => {
    let resolveOld!: (response: {
      ok: boolean;
      status: number;
      body: null;
      json: () => Promise<unknown>;
    }) => void;
    const oldResponse = new Promise<{
      ok: boolean;
      status: number;
      body: null;
      json: () => Promise<unknown>;
    }>((resolve) => (resolveOld = resolve));
    const current = controlledBody();
    core.doFetch
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce({ ok: true, status: 200, body: current.body });
    const messages: import('./vault-change-feed.js').VaultChangeMessage[] = [];
    const off = feedModule.subscribeVaultChanges((message) => messages.push(message));
    await flush();

    await feedModule.setVaultChangeShapeIds(['shape-current']);
    await flush();
    resolveOld({
      ok: false,
      status: 403,
      body: null,
      json: async () => ({ error: 'replica_device_not_enrolled' }),
    });
    await flush();

    expect(core.doFetch).toHaveBeenCalledTimes(2);
    expect(messages).toEqual([]);
    off();
  });

  it('shares one scoped stream, fans changes out, and closes it after the final subscriber', async () => {
    const stream = controlledBody();
    core.doFetch.mockResolvedValue({ ok: true, status: 200, body: stream.body });
    const first: import('./vault-change-feed.js').VaultChangeMessage[] = [];
    const second: import('./vault-change-feed.js').VaultChangeMessage[] = [];
    const offFirst = feedModule.subscribeVaultChanges((message) => first.push(message));
    const offSecond = feedModule.subscribeVaultChanges((message) => second.push(message));
    await flush();

    expect(core.doFetch).toHaveBeenCalledTimes(1);
    expect(core.doFetch.mock.calls[0]?.[1]).toBe('/centraid/_vault/changes?since=0%3A0&stream=1');
    stream.enqueue('event: cursor\ndata: {"epoch":"epoch-a","seq":5}\n\n');
    stream.enqueue(
      'event: change\ndata: {"changes":[{"epoch":"epoch-a","seq":6,"entity":"task","rowId":"task-1","op":"update","changedAt":"2026-07-15T08:00:00.000Z"}],"next":{"epoch":"epoch-a","seq":6}}\n\n',
    );
    await flush();

    expect(first).toEqual(second);
    expect(first).toMatchObject([
      { type: 'centraid:vault-cursor', cursor: { epoch: 'epoch-a', seq: 5 } },
      {
        type: 'centraid:vault-change',
        detail: { entity: 'task', rowId: 'task-1', op: 'update' },
      },
    ]);

    offFirst();
    stream.enqueue(
      'event: change\ndata: {"epoch":"epoch-a","seq":7,"entity":"task","rowId":"task-2","op":"insert","changedAt":"2026-07-15T08:01:00.000Z"}\n\n',
    );
    await flush();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(3);

    offSecond();
    await flush();
    expect(stream.wasCancelled()).toBe(true);
  });

  it('reconnects a closed stream from the last accepted cursor', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const first = controlledBody();
    const second = controlledBody();
    core.doFetch
      .mockResolvedValueOnce({ ok: true, status: 200, body: first.body })
      .mockResolvedValueOnce({ ok: true, status: 200, body: second.body });
    const off = feedModule.subscribeVaultChanges(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    first.enqueue('event: cursor\ndata: "epoch-r:12"\n\n');
    first.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(core.doFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(core.doFetch).toHaveBeenCalledTimes(2);
    expect(core.doFetch.mock.calls[1]?.[1]).toBe(
      '/centraid/_vault/changes?since=epoch-r%3A12&stream=1',
    );

    off();
    vi.useRealTimers();
  });

  it('pauses on a rebootstrap instruction until the snapshot cursor resumes it', async () => {
    vi.useFakeTimers();
    const stale = controlledBody();
    const resumed = controlledBody();
    core.doFetch
      .mockResolvedValueOnce({ ok: true, status: 200, body: stale.body })
      .mockResolvedValueOnce({ ok: true, status: 200, body: resumed.body });
    const messages: import('./vault-change-feed.js').VaultChangeMessage[] = [];
    const off = feedModule.subscribeVaultChanges((message) => messages.push(message));
    await vi.advanceTimersByTimeAsync(0);

    stale.enqueue(
      'event: rebootstrap\ndata: {"reason":"retention","watermark":{"epoch":"epoch-b","seq":40}}\n\n',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toMatchObject([
      { type: 'centraid:vault-rebootstrap', detail: { reason: 'retention' } },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(core.doFetch).toHaveBeenCalledTimes(1);

    await feedModule.resumeVaultChanges({ epoch: 'epoch-b', seq: 40 });
    await vi.advanceTimersByTimeAsync(0);
    expect(core.doFetch).toHaveBeenCalledTimes(2);
    expect(core.doFetch.mock.calls[1]?.[1]).toBe(
      '/centraid/_vault/changes?since=epoch-b%3A40&stream=1',
    );

    off();
    vi.useRealTimers();
  });

  it('turns a revoked stream response into a wipe/rebootstrap signal instead of retrying cached data', async () => {
    vi.useFakeTimers();
    core.doFetch.mockResolvedValue({
      ok: false,
      status: 403,
      body: null,
      json: async () => ({ error: 'replica_device_not_enrolled' }),
    });
    const messages: import('./vault-change-feed.js').VaultChangeMessage[] = [];
    const off = feedModule.subscribeVaultChanges((message) => messages.push(message));
    await vi.advanceTimersByTimeAsync(0);

    expect(messages).toEqual([
      {
        type: 'centraid:vault-rebootstrap',
        detail: { error: 'replica_device_not_enrolled' },
      },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(core.doFetch).toHaveBeenCalledTimes(1);

    off();
    vi.useRealTimers();
  });
});
