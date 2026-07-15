import { beforeAll, describe, expect, test, vi } from 'vitest';

import type { ShellReplicaCoordinator } from './shell-session.js';
import type { ReplicaIntent, ReplicaShape } from './types.js';

let ReplicaShellSession: typeof import('./shell-session.js').ReplicaShellSession;

beforeAll(async () => {
  Object.assign(window, {
    CentraidApi: {
      onGatewayChanged: () => () => undefined,
      onVaultChanged: () => () => undefined,
    },
  });
  ({ ReplicaShellSession } = await import('./shell-session.js'));
});

const shape: ReplicaShape = {
  shapeId: 'shape-todos',
  appId: 'todos',
  purpose: 'dpv:ServiceProvision',
  entities: [{ entity: 'core.task', primaryKey: 'task_id', columns: ['task_id', 'title'] }],
};

function queuedIntent(intentId: string): ReplicaIntent {
  return {
    intentId,
    payloadHash: 'a'.repeat(64),
    appId: 'todos',
    action: 'complete',
    input: { taskId: 'task-1' },
    state: 'queued',
    createdOrder: 1,
    attempts: 0,
    optimistic: [],
  };
}

function coordinator(overrides: Partial<ShellReplicaCoordinator> = {}): ShellReplicaCoordinator {
  return {
    bootstrap: vi.fn().mockResolvedValue({ epoch: 'e', seq: 1 }),
    status: vi.fn().mockResolvedValue({ mode: 'memory', cursor: null, schemaEpoch: null }),
    catalog: vi.fn().mockResolvedValue([shape]),
    readWire: vi.fn(),
    searchWire: vi.fn(),
    enqueue: vi.fn(),
    claimNextIntent: vi.fn().mockResolvedValue(undefined),
    markIntentTransportFailed: vi.fn(async (_intentId, reason) => ({
      ...queuedIntent(_intentId),
      reason,
    })),
    markIntentAwaitingChange: vi.fn(
      async (intentId: string): Promise<ReplicaIntent> => ({
        ...queuedIntent(intentId),
        state: 'awaiting-change',
      }),
    ),
    applyIntentOutcome: vi.fn().mockResolvedValue(undefined),
    recoverSending: vi.fn().mockResolvedValue([]),
    pendingIntents: vi.fn().mockResolvedValue([]),
    subscribeInvalidations: vi.fn().mockReturnValue(() => undefined),
    close: vi.fn().mockResolvedValue(undefined),
    purge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ReplicaShellSession admission ordering', () => {
  test('fans one same-id admission result out to every concurrent writer', async () => {
    let online = false;
    const queued = queuedIntent('shared-intent');
    const replica = coordinator({
      enqueue: vi.fn().mockResolvedValue(queued),
      claimNextIntent: vi
        .fn<() => Promise<ReplicaIntent | undefined>>()
        .mockResolvedValueOnce(queued)
        .mockResolvedValue(undefined),
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(responseFor(queued.intentId, 'parked', 'confirm first'));
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault' },
      replica,
      { fetcher, eventTarget: new EventTarget(), isOnline: () => online },
    );
    await session.start({ mode: 'memory', cursor: { epoch: 'e', seq: 1 }, schemaEpoch: 's' });
    online = true;

    const results = await Promise.all([
      session.write('todos', {
        intentId: queued.intentId,
        action: queued.action,
        input: queued.input,
      }),
      session.write('todos', {
        intentId: queued.intentId,
        action: queued.action,
        input: queued.input,
      }),
    ]);

    expect(results).toEqual([
      { intentId: queued.intentId, status: 'parked', reason: 'confirm first' },
      { intentId: queued.intentId, status: 'parked', reason: 'confirm first' },
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    await session.close();
  });

  test('includes a same-id writer that registers while the first post is settling', async () => {
    let online = false;
    const queued = queuedIntent('shared-intent');
    const duplicateEnqueue = deferred<ReplicaIntent>();
    const post = deferred<Response>();
    const replica = coordinator({
      enqueue: vi.fn().mockResolvedValueOnce(queued).mockReturnValueOnce(duplicateEnqueue.promise),
      claimNextIntent: vi
        .fn<() => Promise<ReplicaIntent | undefined>>()
        .mockResolvedValueOnce(queued)
        .mockResolvedValue(undefined),
    });
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault' },
      replica,
      {
        fetcher: vi.fn().mockReturnValue(post.promise),
        eventTarget: new EventTarget(),
        isOnline: () => online,
      },
    );
    await session.start({ mode: 'memory', cursor: { epoch: 'e', seq: 1 }, schemaEpoch: 's' });
    online = true;

    const first = session.write('todos', {
      intentId: queued.intentId,
      action: queued.action,
      input: queued.input,
    });
    await vi.waitFor(() => expect(replica.claimNextIntent).toHaveBeenCalledOnce());
    const duplicate = session.write('todos', {
      intentId: queued.intentId,
      action: queued.action,
      input: queued.input,
    });
    await vi.waitFor(() => expect(replica.enqueue).toHaveBeenCalledTimes(2));

    post.resolve(responseFor(queued.intentId, 'parked', 'confirm first'));
    duplicateEnqueue.resolve({ ...queued, state: 'sending' });

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { intentId: queued.intentId, status: 'parked', reason: 'confirm first' },
      { intentId: queued.intentId, status: 'parked', reason: 'confirm first' },
    ]);
    await session.close();
  });

  test('does not claim a newly durable intent before its admission waiter is installed', async () => {
    const previous = queuedIntent('previous-intent');
    const queued = queuedIntent('new-intent');
    const enqueueGate = deferred<ReplicaIntent>();
    const previousPost = deferred<Response>();
    const claimNextIntent = vi
      .fn<() => Promise<ReplicaIntent | undefined>>()
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(queued)
      .mockResolvedValue(undefined);
    const replica = coordinator({
      enqueue: vi.fn().mockReturnValue(enqueueGate.promise),
      claimNextIntent,
    });
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(previousPost.promise)
      .mockResolvedValueOnce(responseFor(queued.intentId, 'parked', 'confirm new'));
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault' },
      replica,
      { fetcher, eventTarget: new EventTarget(), isOnline: () => true },
    );
    await session.start({ mode: 'memory', cursor: { epoch: 'e', seq: 1 }, schemaEpoch: 's' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    const result = session.write('todos', {
      intentId: queued.intentId,
      action: queued.action,
      input: queued.input,
    });
    await vi.waitFor(() => expect(replica.enqueue).toHaveBeenCalledOnce());
    previousPost.resolve(responseFor(previous.intentId, 'parked', 'confirm previous'));
    await vi.waitFor(() => expect(replica.applyIntentOutcome).toHaveBeenCalledOnce());
    expect(claimNextIntent).toHaveBeenCalledOnce();

    enqueueGate.resolve(queued);
    await expect(result).resolves.toEqual({
      intentId: queued.intentId,
      status: 'parked',
      reason: 'confirm new',
    });
    expect(claimNextIntent.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await session.close();
  });
});

function responseFor(intentId: string, status: 'parked', reason: string): Response {
  return new Response(
    JSON.stringify({ protocolVersion: 1, outcome: { intentId, status, reason } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
