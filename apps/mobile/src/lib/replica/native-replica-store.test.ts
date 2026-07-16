import { describe, expect, test } from 'vitest';

import { OnlineOnlyError, type ReplicaSnapshot } from '@centraid/client/replica/native';

import { NativeReplicaStore } from './native-replica-store';
import { NodeSqliteDriver } from './node-sqlite-driver';
import { SqliteIntentStore } from './sqlite-intent-store';

function snapshot(): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: 'vault-a',
    schemaEpoch: 'schema-1',
    cursor: { epoch: 'replica-1', seq: 2 },
    shapes: [
      {
        shapeId: 'shape-photos',
        appId: 'photos',
        purpose: 'dpv:ServiceProvision',
        entities: [
          {
            entity: 'core.content_item',
            primaryKey: 'content_id',
            columns: ['content_id', 'title', 'caption', 'deleted_at', 'created_at'],
            hasUnavailableFields: true,
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
          title: 'Moonlit campsite',
          deleted_at: null,
          created_at: '2026-07-15T10:00:00.000Z',
        },
        oversizedFields: ['caption'],
      },
    ],
  };
}

describe('NativeReplicaStore', () => {
  test('reports a native durable mode', async () => {
    const store = NativeReplicaStore.create(new NodeSqliteDriver(), 'vault-a');
    try {
      expect((await store.status()).mode).toBe('native');
    } finally {
      await store.close();
    }
  });

  test('bootstraps and returns clone-safe wire rows', async () => {
    const store = NativeReplicaStore.create(new NodeSqliteDriver(), 'vault-a');
    try {
      expect(await store.bootstrap(snapshot())).toEqual({ epoch: 'replica-1', seq: 2 });
      const wire = await store.readWire({ shapeId: 'shape-photos', entity: 'core.content_item' });
      expect(wire.rows[0]?.values.title).toBe('Moonlit campsite');
      expect(wire.rows[0]?.oversizedFields).toEqual(['caption']);
    } finally {
      await store.close();
    }
  });

  test('read() applies the online-only guard to unavailable fields', async () => {
    const store = NativeReplicaStore.create(new NodeSqliteDriver(), 'vault-a');
    try {
      await store.bootstrap(snapshot());
      const result = await store.read({ shapeId: 'shape-photos', entity: 'core.content_item' });
      const row = result.rows[0]!;
      expect(row.title).toBe('Moonlit campsite');
      expect(() => row.caption).toThrow(OnlineOnlyError);
    } finally {
      await store.close();
    }
  });

  test('searches eager FTS metadata', async () => {
    const store = NativeReplicaStore.create(new NodeSqliteDriver(), 'vault-a');
    try {
      await store.bootstrap(snapshot());
      const result = await store.searchWire({
        shapeId: 'shape-photos',
        entity: 'core.content_item',
        query: 'moon',
      });
      expect(result.rows.map((row) => row.rowId)).toEqual(['photo-1']);
    } finally {
      await store.close();
    }
  });

  test('wipe clears replica tables but preserves the intent outbox sharing the driver', async () => {
    const driver = new NodeSqliteDriver();
    const store = NativeReplicaStore.create(driver, 'vault-a');
    const intents = SqliteIntentStore.create(driver);
    try {
      await store.bootstrap(snapshot());
      await intents.add({
        intentId: 'intent-1',
        payloadHash: 'hash-1',
        appId: 'photos',
        action: 'rename',
        input: { title: 'x' },
        state: 'queued',
        attempts: 0,
        optimistic: [],
        dependencies: [],
      });
      await store.wipe();
      // Replica rows are gone (a read now demands a fresh bootstrap)...
      expect((await store.status()).cursor).toBeNull();
      // ...but the queued intent in its own table survives the wipe.
      expect((await intents.list(['queued'])).map((intent) => intent.intentId)).toEqual([
        'intent-1',
      ]);
    } finally {
      await store.close();
    }
  });
});
