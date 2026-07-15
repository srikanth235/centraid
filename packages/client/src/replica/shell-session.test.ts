import { beforeAll, describe, expect, test, vi } from 'vitest';

import type { ShellReplicaCoordinator } from './shell-session.js';
import { listRememberedReplicaIdentities, rememberReplicaIdentity } from './storage-manifest.js';
import type { ReplicaIntent, ReplicaInvalidation, ReplicaShape } from './types.js';

let ReplicaShellSession: typeof import('./shell-session.js').ReplicaShellSession;
let replicaIdentityForGatewayAuth: typeof import('./shell-session.js').replicaIdentityForGatewayAuth;
let purgeCurrentReplicaDevice: typeof import('./shell-session.js').purgeCurrentReplicaDevice;

beforeAll(async () => {
  Object.assign(window, {
    CentraidApi: {
      getGatewayAuth: () =>
        Promise.resolve({
          baseUrl: 'https://gateway.example',
          gatewayId: 'profile-home',
          vaultId: 'vault',
          rememberDevice: false,
        }),
      onGatewayChanged: () => () => undefined,
      onVaultChanged: () => () => undefined,
    },
  });
  ({ ReplicaShellSession, purgeCurrentReplicaDevice, replicaIdentityForGatewayAuth } =
    await import('./shell-session.js'));
});

const shapes: ReplicaShape[] = [
  {
    shapeId: 'shape-todos',
    appId: 'todos',
    purpose: 'dpv:ServiceProvision',
    entities: [{ entity: 'core.task', primaryKey: 'task_id', columns: ['task_id', 'title'] }],
  },
  {
    shapeId: 'shape-notes',
    appId: 'notes',
    purpose: 'dpv:ServiceProvision',
    entities: [{ entity: 'core.note', primaryKey: 'note_id', columns: ['note_id', 'title'] }],
  },
  {
    shapeId: 'shape-todos-billing',
    appId: 'todos',
    purpose: 'dpv:Billing',
    entities: [{ entity: 'core.task', primaryKey: 'task_id', columns: ['task_id', 'cost'] }],
  },
];

function intent(): ReplicaIntent {
  return {
    intentId: 'intent-1',
    payloadHash: 'a'.repeat(64),
    appId: 'todos',
    action: 'complete',
    input: { taskId: 'task-1' },
    state: 'sending',
    createdOrder: 1,
    attempts: 1,
    optimistic: [],
  };
}

function fakeCoordinator(
  overrides: Partial<ShellReplicaCoordinator> = {},
): ShellReplicaCoordinator {
  return {
    bootstrap: vi.fn().mockResolvedValue({ epoch: 'e', seq: 1 }),
    status: vi.fn().mockResolvedValue({ mode: 'memory', cursor: null, schemaEpoch: null }),
    catalog: vi.fn().mockResolvedValue(shapes),
    readWire: vi.fn().mockResolvedValue({
      rows: [],
      cursor: { epoch: 'e', seq: 1 },
      dependency: { shapeId: 'shape-todos', entity: 'core.task' },
    }),
    searchWire: vi.fn().mockResolvedValue({
      rows: [],
      cursor: { epoch: 'e', seq: 1 },
      dependency: { shapeId: 'shape-todos', entity: 'core.task' },
    }),
    enqueue: vi.fn().mockResolvedValue(intent()),
    claimNextIntent: vi.fn().mockResolvedValue(undefined),
    markIntentTransportFailed: vi.fn().mockResolvedValue(intent()),
    markIntentAwaitingChange: vi.fn().mockResolvedValue(intent()),
    applyIntentOutcome: vi.fn().mockResolvedValue(intent()),
    recoverSending: vi.fn().mockResolvedValue([]),
    pendingIntents: vi.fn().mockResolvedValue([]),
    subscribeInvalidations: vi.fn().mockReturnValue(() => undefined),
    close: vi.fn().mockResolvedValue(undefined),
    purge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ReplicaShellSession', () => {
  test('keys storage by stable gateway identity rather than a transient transport URL', () => {
    expect(
      replicaIdentityForGatewayAuth({
        baseUrl: 'http://127.0.0.1:49152',
        gatewayId: 'profile-home',
        vaultId: 'vault',
      }),
    ).toEqual({ gatewayId: 'profile-home', vaultId: 'vault' });
    expect(
      replicaIdentityForGatewayAuth({
        baseUrl: 'https://EXAMPLE.test/root/?temporary=1',
        vaultId: 'vault',
      }),
    ).toEqual({ gatewayId: 'url:https://example.test/root', vaultId: 'vault' });
  });

  test('self-revoke cleanup eagerly purges browser replica caches without an open session', async () => {
    localStorage.clear();
    const deleteCache = vi.fn().mockResolvedValue(true);
    const postMessage = vi.fn();
    const priorCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    const priorServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        keys: vi.fn().mockResolvedValue(['centraid-tunnel-assets-device', 'unrelated-cache']),
        delete: deleteCache,
      },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: { postMessage } },
    });
    try {
      await purgeCurrentReplicaDevice();
      await vi.waitFor(() =>
        expect(deleteCache).toHaveBeenCalledWith('centraid-tunnel-assets-device'),
      );
      expect(deleteCache).not.toHaveBeenCalledWith('unrelated-cache');
      expect(postMessage).toHaveBeenCalledWith({ type: 'centraid:purge-tunnel-cache' });
    } finally {
      if (priorCaches) Object.defineProperty(globalThis, 'caches', priorCaches);
      else Reflect.deleteProperty(globalThis, 'caches');
      if (priorServiceWorker) Object.defineProperty(navigator, 'serviceWorker', priorServiceWorker);
      else Reflect.deleteProperty(navigator, 'serviceWorker');
      localStorage.clear();
    }
  });

  test('closing for a gateway switch preserves remembered storage for a warm return', async () => {
    localStorage.clear();
    const identity = { gatewayId: 'profile-home', vaultId: 'vault' };
    rememberReplicaIdentity(identity);
    const coordinator = fakeCoordinator();
    const session = new ReplicaShellSession(
      {
        baseUrl: 'http://127.0.0.1:49152',
        gatewayId: identity.gatewayId,
        vaultId: identity.vaultId,
        rememberDevice: true,
      },
      coordinator,
      { eventTarget: new EventTarget(), isOnline: () => false, rememberStorage: true },
    );

    await session.close();

    expect(coordinator.close).toHaveBeenCalledOnce();
    expect(coordinator.purge).not.toHaveBeenCalled();
    expect(listRememberedReplicaIdentities()).toEqual([identity]);
    localStorage.clear();
  });

  test('terminal scope purge forgets the durable manifest only after storage is wiped', async () => {
    localStorage.clear();
    const identity = { gatewayId: 'profile-home', vaultId: 'vault' };
    rememberReplicaIdentity(identity);
    const coordinator = fakeCoordinator();
    const session = new ReplicaShellSession(
      {
        baseUrl: 'http://127.0.0.1:49152',
        gatewayId: identity.gatewayId,
        vaultId: identity.vaultId,
        rememberDevice: true,
      },
      coordinator,
      { eventTarget: new EventTarget(), isOnline: () => false, rememberStorage: true },
    );

    await session.purge();

    expect(coordinator.purge).toHaveBeenCalledOnce();
    expect(listRememberedReplicaIdentities()).toEqual([]);
  });

  test('keeps the manifest entry when terminal storage purge fails', async () => {
    localStorage.clear();
    const identity = { gatewayId: 'profile-home', vaultId: 'vault' };
    rememberReplicaIdentity(identity);
    const session = new ReplicaShellSession(
      {
        baseUrl: 'http://127.0.0.1:49152',
        gatewayId: identity.gatewayId,
        vaultId: identity.vaultId,
        rememberDevice: true,
      },
      fakeCoordinator({ purge: vi.fn().mockRejectedValue(new Error('OPFS busy')) }),
      { eventTarget: new EventTarget(), isOnline: () => false, rememberStorage: true },
    );

    await expect(session.purge()).rejects.toThrow('OPFS busy');
    expect(listRememberedReplicaIdentities()).toEqual([identity]);
    localStorage.clear();
  });

  test('reuses a warm catalog, maps app entities and filters subscription invalidations', async () => {
    let emit: ((values: readonly ReplicaInvalidation[]) => void) | undefined;
    const listener = vi.fn();
    const coordinator = fakeCoordinator({
      subscribeInvalidations: vi.fn((next) => {
        emit = next;
        return () => undefined;
      }),
    });
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault', rememberDevice: true },
      coordinator,
      { eventTarget: new EventTarget(), isOnline: () => false },
    );
    await session.start({
      mode: 'opfs-sahpool',
      cursor: { epoch: 'warm', seq: 42 },
      schemaEpoch: 'schema',
    });
    expect(coordinator.bootstrap).not.toHaveBeenCalled();
    await session.read('todos', { entity: 'core.task' });
    expect(coordinator.readWire).toHaveBeenCalledWith({
      shapeId: 'shape-todos',
      entity: 'core.task',
    });
    await session.read('todos', { entity: 'core.task', purpose: 'dpv:Billing' });
    expect(coordinator.readWire).toHaveBeenLastCalledWith({
      shapeId: 'shape-todos-billing',
      entity: 'core.task',
      purpose: 'dpv:Billing',
    });
    await session.search('todos', { entity: 'core.task', query: 'local' });
    expect(coordinator.searchWire).toHaveBeenCalledWith({
      shapeId: 'shape-todos',
      entity: 'core.task',
      query: 'local',
    });

    session.subscribe('todos', [{ entity: 'core.task' }], listener);
    emit?.([
      { shapeId: 'shape-notes', entity: 'core.note', source: 'canonical' },
      { shapeId: 'shape-todos-billing', entity: 'core.task', source: 'canonical' },
      { shapeId: 'shape-todos', entity: 'core.task', source: 'canonical' },
    ]);
    expect(listener).toHaveBeenCalledWith([
      { shapeId: 'shape-todos', entity: 'core.task', source: 'canonical' },
    ]);
    const billingListener = vi.fn();
    session.subscribe(
      'todos',
      [{ shapeId: 'shape-todos-billing', entity: 'core.task' }],
      billingListener,
    );
    emit?.([
      { shapeId: 'shape-todos', entity: 'core.task', source: 'canonical' },
      { shapeId: 'shape-todos-billing', entity: 'core.task', source: 'canonical' },
    ]);
    expect(billingListener).toHaveBeenCalledWith([
      { shapeId: 'shape-todos-billing', entity: 'core.task', source: 'canonical' },
    ]);
    await session.purge();
  });

  test('retries a transient bootstrap failure without waiting for an online event', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = fakeCoordinator();
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'gateway_error' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              vaultId: 'vault',
              schemaEpoch: 'schema',
              cursor: { epoch: 'epoch', seq: 7 },
              shapes: [],
              rows: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      const session = new ReplicaShellSession(
        { baseUrl: 'https://gateway.example', vaultId: 'vault' },
        coordinator,
        { fetcher, eventTarget: new EventTarget(), isOnline: () => true, retryDelayMs: 10 },
      );

      await session.start({ mode: 'memory', cursor: null, schemaEpoch: null });
      expect(coordinator.bootstrap).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(coordinator.bootstrap).toHaveBeenCalledOnce());
      expect(fetcher).toHaveBeenCalledTimes(2);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('ships an idempotent intent and keeps its overlay until canonical execution arrives', async () => {
    const queued = intent();
    const claimNextIntent = vi
      .fn<() => Promise<ReplicaIntent | undefined>>()
      .mockResolvedValueOnce(queued)
      .mockResolvedValue(undefined);
    const coordinator = fakeCoordinator({ claimNextIntent });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          outcome: { intentId: queued.intentId, status: 'executed' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault' },
      coordinator,
      { fetcher, eventTarget: new EventTarget(), isOnline: () => true },
    );
    await session.start({ mode: 'memory', cursor: { epoch: 'e', seq: 1 }, schemaEpoch: 's' });
    await session.flushIntents();
    expect(JSON.parse(String(fetcher.mock.calls[0]![2].body))).toEqual({
      intentId: queued.intentId,
      appId: queued.appId,
      action: queued.action,
      input: queued.input,
      payloadHash: queued.payloadHash,
    });
    expect(coordinator.markIntentAwaitingChange).toHaveBeenCalledWith(queued.intentId);
    expect(coordinator.applyIntentOutcome).not.toHaveBeenCalled();
    await session.close();
  });

  test('returns a durable queued acknowledgement immediately while offline', async () => {
    const coordinator = fakeCoordinator();
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault' },
      coordinator,
      { eventTarget: new EventTarget(), isOnline: () => false },
    );
    await session.start({ mode: 'memory', cursor: { epoch: 'e', seq: 1 }, schemaEpoch: 's' });

    await expect(
      session.write('todos', {
        action: 'complete',
        input: { taskId: 'task-1' },
        optimistic: [
          {
            op: 'upsert',
            entity: 'core.task',
            rowId: 'task-1',
            values: { cost: 42 },
            purpose: 'dpv:Billing',
          },
        ],
      }),
    ).resolves.toEqual({
      intentId: 'intent-1',
      status: 'queued',
      reason: 'waiting for a connection',
    });
    expect(coordinator.enqueue).toHaveBeenCalledWith({
      appId: 'todos',
      action: 'complete',
      input: { taskId: 'task-1' },
      optimistic: [
        {
          op: 'upsert',
          shapeId: 'shape-todos-billing',
          entity: 'core.task',
          rowId: 'task-1',
          values: { cost: 42 },
        },
      ],
    });
    expect(coordinator.claimNextIntent).not.toHaveBeenCalled();
    await session.close();
  });

  test('returns the gateway admission outcome for an online write', async () => {
    let online = false;
    const queued = intent();
    const coordinator = fakeCoordinator({
      claimNextIntent: vi
        .fn<() => Promise<ReplicaIntent | undefined>>()
        .mockResolvedValueOnce(queued)
        .mockResolvedValue(undefined),
    });
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault' },
      coordinator,
      {
        eventTarget: new EventTarget(),
        isOnline: () => online,
        fetcher: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              outcome: { intentId: queued.intentId, status: 'parked', reason: 'confirm first' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      },
    );
    await session.start({ mode: 'memory', cursor: { epoch: 'e', seq: 1 }, schemaEpoch: 's' });
    online = true;

    await expect(
      session.write('todos', { action: 'complete', input: { taskId: 'task-1' } }),
    ).resolves.toEqual({
      intentId: 'intent-1',
      status: 'parked',
      reason: 'confirm first',
    });
    expect(coordinator.applyIntentOutcome).toHaveBeenCalledWith({
      intentId: 'intent-1',
      status: 'parked',
      reason: 'confirm first',
    });
    await session.close();
  });

  test('reruns an active drain when an enqueue races its empty claim', async () => {
    let releaseEmptyClaim: (() => void) | undefined;
    const emptyClaim = new Promise<undefined>((resolve) => {
      releaseEmptyClaim = () => resolve(undefined);
    });
    const queued = intent();
    const claimNextIntent = vi
      .fn<() => Promise<ReplicaIntent | undefined>>()
      .mockReturnValueOnce(emptyClaim)
      .mockResolvedValueOnce(queued)
      .mockResolvedValue(undefined);
    const coordinator = fakeCoordinator({ claimNextIntent });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          outcome: { intentId: queued.intentId, status: 'parked', reason: 'confirm first' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault' },
      coordinator,
      { fetcher, eventTarget: new EventTarget(), isOnline: () => true },
    );
    await session.start({ mode: 'memory', cursor: { epoch: 'e', seq: 1 }, schemaEpoch: 's' });
    expect(claimNextIntent).toHaveBeenCalledOnce();

    const result = session.write('todos', {
      action: queued.action,
      input: queued.input,
    });
    await vi.waitFor(() => expect(coordinator.enqueue).toHaveBeenCalledOnce());
    releaseEmptyClaim?.();

    await expect(result).resolves.toEqual({
      intentId: queued.intentId,
      status: 'parked',
      reason: 'confirm first',
    });
    expect(claimNextIntent).toHaveBeenCalledTimes(3);
    await session.close();
  });

  test('purges OPFS and IDB state when the gateway revokes authorization', async () => {
    const coordinator = fakeCoordinator({
      claimNextIntent: vi
        .fn<() => Promise<ReplicaIntent | undefined>>()
        .mockResolvedValueOnce(intent())
        .mockResolvedValue(undefined),
    });
    const revoked = vi.fn();
    const session = new ReplicaShellSession(
      { baseUrl: 'https://gateway.example', vaultId: 'vault' },
      coordinator,
      {
        fetcher: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'replica_device_not_enrolled' }), {
            status: 403,
          }),
        ),
        eventTarget: new EventTarget(),
        isOnline: () => true,
        onAuthorizationRevoked: revoked,
      },
    );
    await session.start({ mode: 'memory', cursor: { epoch: 'e', seq: 1 }, schemaEpoch: 's' });
    await session.flushIntents();
    expect(revoked).toHaveBeenCalledWith(session);
    expect(coordinator.purge).toHaveBeenCalledOnce();
  });
});
