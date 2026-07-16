import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type {
  GatewayAuth,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaDigest,
  ReplicaIdFactory,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
  VaultChangeMessage,
} from '@centraid/client/replica/native';

import type { AppStateLike, NativeChangeFeed } from './native-session';
import { createNativeReplicaSession } from './native-session';
import { NodeSqliteDriver } from './node-sqlite-driver';

const gatewayAuth: GatewayAuth = {
  baseUrl: 'http://127.0.0.1:18789',
  gatewayId: 'gateway-1',
  vaultId: 'vault-a',
};

/**
 * Hermes has neither `crypto.subtle` nor `crypto.randomUUID`, so the session
 * takes both by injection; on device `./native-hash` supplies the expo-crypto
 * pair. Injecting here also keeps these node runs from loading an Expo native
 * module. `nodeDigest` is hex SHA-256 over UTF-8 — the same contract
 * `expo-crypto` and `crypto.subtle` satisfy, so payload hashes are identical.
 */
const nodeDigest: ReplicaDigest = (input) =>
  Promise.resolve(createHash('sha256').update(input, 'utf8').digest('hex'));

function sequentialIds(): ReplicaIdFactory {
  let next = 0;
  return () => `intent-${++next}`;
}

/**
 * One windowed bootstrap page. Native always bootstraps windowed, so page 1
 * carries the catalog and every page reports its own snapshot cursor.
 */
function page(
  cursor: ReplicaCursor,
  options: { rows?: ReplicaSnapshotRow[]; next?: string; first?: boolean } = {},
): Record<string, unknown> {
  const full = snapshot(cursor);
  return {
    protocolVersion: 1,
    vaultId: 'vault-a',
    schemaEpoch: 'schema-1',
    cursor,
    rows: options.rows ?? full.rows,
    complete: options.next === undefined,
    ...(options.next ? { next: options.next } : {}),
    ...(options.first === false ? {} : { shapes: full.shapes, shapeIds: ['shape-photos'] }),
  };
}

/** An already-converged delta pull: the mandatory post-bootstrap replay finds nothing. */
function noChanges(cursor: ReplicaCursor): ReplicaChangeBatch {
  return { protocolVersion: 1, schemaEpoch: 'schema-1', from: cursor, to: cursor, changes: [] };
}

function snapshot(cursor: ReplicaCursor): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: 'vault-a',
    schemaEpoch: 'schema-1',
    cursor,
    shapes: [
      {
        shapeId: 'shape-photos',
        appId: 'photos',
        purpose: 'dpv:ServiceProvision',
        entities: [
          {
            entity: 'core.content_item',
            primaryKey: 'content_id',
            columns: ['content_id', 'title', 'deleted_at', 'created_at'],
          },
        ],
      },
    ],
    rows: [
      {
        shapeId: 'shape-photos',
        entity: 'core.content_item',
        rowId: 'photo-1',
        values: {
          content_id: 'photo-1',
          title: 'Original',
          deleted_at: null,
          created_at: '2026-07-15T10:00:00.000Z',
        },
      },
    ],
  };
}

interface FakeFeed extends NativeChangeFeed {
  readonly active: boolean;
  readonly shapeIds: readonly string[];
  emit(message: VaultChangeMessage): void;
}

/** Records active toggles and lets the test drive coordinator feed messages. */
function createFeed(): FakeFeed {
  let listener: ((message: VaultChangeMessage) => void) | undefined;
  let active = false;
  let shapeIds: readonly string[] = [];
  return {
    get active() {
      return active;
    },
    get shapeIds() {
      return shapeIds;
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async setShapeIds(next) {
      shapeIds = next;
    },
    async resume() {
      /* The coordinator only needs resume to resolve. */
    },
    setActive(next) {
      active = next;
    },
    emit(message) {
      listener?.(message);
    },
  };
}

interface FakeAppState extends AppStateLike {
  send(state: string): void;
}

function createAppState(): FakeAppState {
  let handler: ((state: string) => void) | undefined;
  let currentState = 'active';
  return {
    get currentState() {
      return currentState;
    },
    addEventListener(_type, next) {
      handler = next;
      return {
        remove: () => {
          handler = undefined;
        },
      };
    },
    send(state) {
      currentState = state;
      handler?.(state);
    },
  };
}

type Responder = () => Response;

interface FakeGateway {
  on(pathFragment: string, responder: Responder): FakeGateway;
  readonly fetcher: (baseUrl: string, pathname: string, init: RequestInit) => Promise<Response>;
}

/** Programmable transport keyed by path, with a per-path FIFO of responders. */
function createGateway(): FakeGateway {
  const queues = new Map<string, Responder[]>();
  const gateway: FakeGateway = {
    on(pathFragment, responder) {
      const queue = queues.get(pathFragment) ?? [];
      queue.push(responder);
      queues.set(pathFragment, queue);
      return gateway;
    },
    fetcher: (_baseUrl, pathname) => {
      for (const [fragment, queue] of queues) {
        if (pathname.includes(fragment) && queue.length > 0) {
          return Promise.resolve(queue.shift()!());
        }
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  };
  return gateway;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function changeBatch(from: ReplicaCursor, to: ReplicaCursor): ReplicaChangeBatch {
  return {
    protocolVersion: 1,
    schemaEpoch: 'schema-1',
    from,
    to,
    changes: [
      {
        op: 'upsert',
        shapeId: 'shape-photos',
        entity: 'core.content_item',
        rowId: 'photo-1',
        values: {
          content_id: 'photo-1',
          title: 'Renamed',
          deleted_at: null,
          created_at: '2026-07-15T10:00:00.000Z',
        },
      },
    ],
  };
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('createNativeReplicaSession', () => {
  test('bootstraps on start and pulls deltas when the feed reports a newer cursor', async () => {
    const gateway = createGateway()
      .on('/replica/bootstrap', () => json(page({ epoch: 'replica-1', seq: 1 })))
      // The bootstrap's own convergence replay runs first and finds nothing.
      .on('/changes', () => json(noChanges({ epoch: 'replica-1', seq: 1 })))
      .on('/changes', () =>
        json(changeBatch({ epoch: 'replica-1', seq: 1 }, { epoch: 'replica-1', seq: 2 })),
      );
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    try {
      expect((await session.status()).cursor).toEqual({ epoch: 'replica-1', seq: 1 });
      expect(feed.active).toBe(true);

      feed.emit({ type: 'centraid:vault-cursor', cursor: { epoch: 'replica-1', seq: 2 } });
      await until(async () => (await session.status()).cursor?.seq === 2);

      const read = await session.read('photos', { entity: 'core.content_item' });
      expect(read.rows[0]?.values.title).toBe('Renamed');
    } finally {
      await session.close();
    }
  });

  test('pauses the feed on background and resumes it on foreground', async () => {
    const gateway = createGateway()
      .on('/replica/bootstrap', () => json(page({ epoch: 'replica-1', seq: 1 })))
      .on('/changes', () => json(noChanges({ epoch: 'replica-1', seq: 1 })));
    const feed = createFeed();
    const appState = createAppState();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      appState,
    });
    try {
      expect(feed.active).toBe(true);
      appState.send('background');
      expect(feed.active).toBe(false);
      appState.send('active');
      expect(feed.active).toBe(true);
    } finally {
      await session.close();
    }
  });

  test('write() enqueues and ships an intent using the injected Hermes crypto', async () => {
    const gateway = createGateway()
      .on('/replica/bootstrap', () => json(page({ epoch: 'replica-1', seq: 1 })))
      .on('/changes', () => json(noChanges({ epoch: 'replica-1', seq: 1 })))
      .on('/replica/intents', () =>
        json({ outcome: { intentId: 'intent-1', status: 'executed' } }),
      );
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    try {
      // Without injection this path throws on device: RN has no crypto.subtle
      // for the payload hash and no crypto.randomUUID for the intent id.
      const result = await session.write('photos', {
        action: 'photos.favorite',
        input: { assetId: 'asset-1', favorite: true },
      });
      expect(result).toMatchObject({ intentId: 'intent-1', status: 'executed' });

      const [intent] = await session.coordinator.intents.list();
      expect(intent?.payloadHash).toBe(
        // The pinned cross-platform hash: identical under crypto.subtle,
        // expo-crypto and this node digest, so intent idempotency survives a
        // device swap.
        '9fb4ce111fbf05254e7437936d9e5082d6888dd4112fe38c8254c6d1beff844f',
      );
    } finally {
      await session.close();
    }
  });

  test('bootstraps a multi-page window and converges from the page-1 cursor', async () => {
    const rows = (id: string): ReplicaSnapshotRow[] => [
      {
        shapeId: 'shape-photos',
        entity: 'core.content_item',
        rowId: id,
        values: {
          content_id: id,
          title: id,
          deleted_at: null,
          created_at: '2026-07-15T10:00:00.000Z',
        },
      },
    ];
    const gateway = createGateway()
      // Page 1 pins the delta floor at seq 1; page 2 is read from a later snapshot.
      .on('/replica/bootstrap', () =>
        json(page({ epoch: 'replica-1', seq: 1 }, { rows: rows('photo-a'), next: 'token-2' })),
      )
      .on('/replica/bootstrap', () =>
        json(page({ epoch: 'replica-1', seq: 3 }, { rows: rows('photo-b'), first: false })),
      )
      // The mandatory replay from seq 1 removes what page 1 handed us but that
      // was deleted before page 2's snapshot — the deletion hole this closes.
      .on('/changes', () =>
        json({
          protocolVersion: 1,
          schemaEpoch: 'schema-1',
          from: { epoch: 'replica-1', seq: 1 },
          to: { epoch: 'replica-1', seq: 3 },
          changes: [
            {
              op: 'delete',
              shapeId: 'shape-photos',
              entity: 'core.content_item',
              rowId: 'photo-a',
            },
          ],
        }),
      )
      .on('/changes', () => json(noChanges({ epoch: 'replica-1', seq: 3 })));
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      bootstrapWindow: 1,
    });
    try {
      const read = await session.read('photos', { entity: 'core.content_item' });
      expect(read.rows.map((row) => row.values.content_id)).toEqual(['photo-b']);
      expect((await session.status()).cursor).toEqual({ epoch: 'replica-1', seq: 3 });
    } finally {
      await session.close();
    }
  });

  test('a 409 pull rebootstraps without dropping a queued intent', async () => {
    const gateway = createGateway()
      .on('/replica/bootstrap', () => json(page({ epoch: 'replica-1', seq: 1 })))
      .on('/changes', () => json(noChanges({ epoch: 'replica-1', seq: 1 })))
      .on('/changes', () => json({ reason: 'restore' }, 409))
      .on('/replica/outcomes', () => json({ outcomes: [] }))
      .on('/replica/bootstrap', () => json(page({ epoch: 'replica-2', seq: 5 })))
      .on('/changes', () => json(noChanges({ epoch: 'replica-2', seq: 5 })));
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => true,
    });
    try {
      // Queue an intent directly so it stays 'queued' (no drain shipping it).
      await session.coordinator.enqueue({
        appId: 'photos',
        action: 'rename',
        input: { title: 'Local edit' },
      });
      expect((await session.coordinator.pendingIntents()).map((i) => i.intentId)).toHaveLength(1);

      feed.emit({ type: 'centraid:vault-cursor', cursor: { epoch: 'replica-1', seq: 2 } });
      // The 409 pull wipes canonical state and re-bootstraps to the new epoch.
      await until(async () => (await session.status()).cursor?.epoch === 'replica-2');

      // The queued intent lives in its own table and survives the wipe.
      const pending = await session.coordinator.pendingIntents();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.state).toBe('queued');
    } finally {
      await session.close();
    }
  });
});
