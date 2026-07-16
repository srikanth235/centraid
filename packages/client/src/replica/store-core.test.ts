// Proves the ReplicaSqliteStore core is driver-neutral: the same corpus runs
// against the sqlite-wasm adapter (the web engine) and a node:sqlite adapter
// (the CI stand-in for op-sqlite, which cannot load under vitest on macOS/node).
import { DatabaseSync } from 'node:sqlite';

import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, test } from 'vitest';

import {
  OnlineOnlyError,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
} from './errors.js';
import { SqliteReplicaStore } from './sqlite-store.js';
import {
  ReplicaSqliteStore,
  type ReplicaBindValue,
  type ReplicaSqliteDriver,
} from './store-core.js';
import type { ReplicaChangeBatch, ReplicaSnapshot } from './types.js';

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

/** node:sqlite adapter — the same synchronous seam op-sqlite fills on device. */
class NodeSqliteDriver implements ReplicaSqliteDriver {
  private readonly db = new DatabaseSync(':memory:');

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    this.db.prepare(sql).run(...bind);
  }

  all<T extends object>(sql: string, bind: readonly ReplicaBindValue[] = []): T[] {
    return this.db.prepare(sql).all(...bind) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

type MakeStore = () => ReplicaSqliteStore;

function snapshot(): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: 'vault-a',
    schemaEpoch: 'schema-1',
    cursor: { epoch: 'replica-1', seq: 2 },
    shapes: [
      {
        shapeId: 'shape-agenda',
        appId: 'agenda',
        purpose: 'dpv:ServiceProvision',
        entities: [
          {
            entity: 'core.event',
            primaryKey: 'event_id',
            columns: ['event_id', 'title', 'status', 'starts_at', 'body'],
            hasUnavailableFields: true,
          },
        ],
      },
    ],
    rows: [
      {
        shapeId: 'shape-agenda',
        entity: 'core.event',
        rowId: 'event-1',
        values: {
          event_id: 'event-1',
          title: 'Earlier',
          status: 'open',
          starts_at: '2026-07-15T08:00:00.000Z',
        },
        oversizedFields: ['body'],
      },
      {
        shapeId: 'shape-agenda',
        entity: 'core.event',
        rowId: 'event-2',
        values: {
          event_id: 'event-2',
          title: 'Later',
          status: 'open',
          starts_at: '2026-07-15T10:00:00.000Z',
          body: 'small',
        },
      },
    ],
  };
}

function searchableSnapshot(): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: 'vault-a',
    schemaEpoch: 'schema-search',
    cursor: { epoch: 'replica-search', seq: 1 },
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
        rowId: 'photo-new',
        values: {
          content_id: 'photo-new',
          title: 'Today at the park',
          deleted_at: null,
          created_at: '2026-07-15T10:00:00.000Z',
        },
      },
      {
        shapeId: 'shape-photos',
        entity: 'core.content_item',
        rowId: 'photo-off-window',
        values: {
          content_id: 'photo-off-window',
          title: 'Moonlit campsite in Ladakh',
          deleted_at: null,
          created_at: '2024-01-01T10:00:00.000Z',
        },
      },
    ],
  };
}

function runStoreConformance(makeStore: MakeStore): void {
  test('bootstraps a shape and executes a bounded local read', () => {
    const store = makeStore();
    try {
      expect(store.bootstrap(snapshot())).toEqual({ epoch: 'replica-1', seq: 2 });
      const result = store.read({
        shapeId: 'shape-agenda',
        entity: 'core.event',
        where: [{ column: 'status', op: 'eq', value: 'open' }],
        orderBy: { column: 'starts_at', dir: 'desc' },
        limit: 1,
      });
      expect(result.rows.map((row) => row.values.title)).toEqual(['Later']);
      expect(store.status()).toEqual({
        cursor: { epoch: 'replica-1', seq: 2 },
        schemaEpoch: 'schema-1',
      });
      expect(store.catalog()).toEqual(snapshot().shapes);
    } finally {
      store.close();
    }
  });

  test('rolls back a whole change batch when any change is invalid', () => {
    const store = makeStore();
    try {
      store.bootstrap(snapshot());
      const batch: ReplicaChangeBatch = {
        protocolVersion: 1,
        schemaEpoch: 'schema-1',
        from: { epoch: 'replica-1', seq: 2 },
        to: { epoch: 'replica-1', seq: 3 },
        changes: [
          {
            op: 'upsert',
            shapeId: 'shape-agenda',
            entity: 'core.event',
            rowId: 'event-3',
            values: {
              event_id: 'event-3',
              title: 'Must roll back',
              status: 'open',
              starts_at: '2026-07-15T12:00:00.000Z',
            },
          },
          { op: 'delete', shapeId: 'shape-agenda', entity: 'missing.entity', rowId: 'missing' },
        ],
      };
      expect(() => store.applyChanges(batch)).toThrow(ReplicaProtocolError);
      expect(store.status().cursor).toEqual({ epoch: 'replica-1', seq: 2 });
      expect(store.read({ shapeId: 'shape-agenda', entity: 'core.event' }).rows).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test('applies upserts and deletes at one cursor and returns intent outcomes', () => {
    const store = makeStore();
    try {
      store.bootstrap(snapshot());
      const applied = store.applyChanges({
        protocolVersion: 1,
        schemaEpoch: 'schema-1',
        from: { epoch: 'replica-1', seq: 2 },
        to: { epoch: 'replica-1', seq: 3 },
        changes: [
          { op: 'delete', shapeId: 'shape-agenda', entity: 'core.event', rowId: 'event-1' },
          {
            op: 'upsert',
            shapeId: 'shape-agenda',
            entity: 'core.event',
            rowId: 'event-2',
            values: {
              event_id: 'event-2',
              title: 'Canonical update',
              status: 'done',
              starts_at: '2026-07-15T10:00:00.000Z',
              body: 'small',
            },
          },
        ],
        outcomes: [{ intentId: 'intent-1', status: 'executed' }],
      });
      expect(applied.cursor).toEqual({ epoch: 'replica-1', seq: 3 });
      expect(applied.outcomes).toEqual([{ intentId: 'intent-1', status: 'executed' }]);
      expect(
        store
          .read({ shapeId: 'shape-agenda', entity: 'core.event' })
          .rows.map((row) => row.values.title),
      ).toEqual(['Canonical update']);
    } finally {
      store.close();
    }
  });

  test('oversized predicates fail online-only instead of returning an incomplete result', () => {
    const store = makeStore();
    try {
      store.bootstrap(snapshot());
      expect(() =>
        store.read({
          shapeId: 'shape-agenda',
          entity: 'core.event',
          where: [{ column: 'body', op: 'eq', value: 'small' }],
        }),
      ).toThrow(OnlineOnlyError);
    } finally {
      store.close();
    }
  });

  test('ranks FTS matches over eager metadata outside the normal read window', () => {
    const store = makeStore();
    try {
      store.bootstrap(searchableSnapshot());
      const result = store.search({
        shapeId: 'shape-photos',
        entity: 'core.content_item',
        query: 'moon camp',
        limit: 10,
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.values).toMatchObject({
        content_id: 'photo-off-window',
        title: 'Moonlit campsite in Ladakh',
      });
      expect(result.rows[0]?.values._snippet).toContain('⟦Moonlit⟧');
    } finally {
      store.close();
    }
  });

  test('keeps FTS search current with incremental replica changes', () => {
    const store = makeStore();
    try {
      store.bootstrap(searchableSnapshot());
      store.applyChanges({
        protocolVersion: 1,
        schemaEpoch: 'schema-search',
        from: { epoch: 'replica-search', seq: 1 },
        to: { epoch: 'replica-search', seq: 2 },
        changes: [
          {
            op: 'upsert',
            shapeId: 'shape-photos',
            entity: 'core.content_item',
            rowId: 'photo-off-window',
            values: {
              content_id: 'photo-off-window',
              title: 'Sunny afternoon',
              deleted_at: null,
              created_at: '2024-01-01T10:00:00.000Z',
            },
          },
        ],
      });
      expect(
        store.search({ shapeId: 'shape-photos', entity: 'core.content_item', query: 'moon' }).rows,
      ).toHaveLength(0);
      expect(
        store.search({ shapeId: 'shape-photos', entity: 'core.content_item', query: 'sunny' }).rows,
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test('epoch mismatch wipes canonical state and requires a new snapshot', () => {
    const store = makeStore();
    try {
      store.bootstrap(snapshot());
      expect(() =>
        store.applyChanges({
          protocolVersion: 1,
          schemaEpoch: 'schema-1',
          from: { epoch: 'replica-2', seq: 0 },
          to: { epoch: 'replica-2', seq: 1 },
          changes: [],
        }),
      ).toThrow(ReplicaRebootstrapRequiredError);
      expect(store.status()).toEqual({ cursor: null, schemaEpoch: null });
    } finally {
      store.close();
    }
  });

  test('destructively rebuilds an incompatible v0 replica schema', () => {
    const store = makeStore();
    try {
      expect(store.status()).toEqual({ cursor: null, schemaEpoch: null });
      expect(store.catalog()).toEqual([]);
      expect(store.bootstrap(snapshot())).toEqual({ epoch: 'replica-1', seq: 2 });
    } finally {
      store.close();
    }
  });

  test('applies a windowed bootstrap page-wise and reads it after commit', () => {
    const store = makeStore();
    try {
      const full = snapshot();
      const header = {
        protocolVersion: full.protocolVersion,
        vaultId: full.vaultId,
        schemaEpoch: full.schemaEpoch,
        shapes: full.shapes,
      };
      store.bootstrapBegin(header);
      // One row per page, as the windowed protocol would deliver them.
      store.bootstrapPage([full.rows[0]!]);
      store.bootstrapPage([full.rows[1]!]);
      expect(store.bootstrapCommit(full.cursor)).toEqual({ epoch: 'replica-1', seq: 2 });
      expect(store.status()).toEqual({
        cursor: { epoch: 'replica-1', seq: 2 },
        schemaEpoch: 'schema-1',
      });
      expect(store.catalog()).toEqual(full.shapes);
      expect(
        store
          .read({ shapeId: 'shape-agenda', entity: 'core.event' })
          .rows.map((row) => row.rowId)
          .sort(),
      ).toEqual(['event-1', 'event-2']);
    } finally {
      store.close();
    }
  });

  test('an uncommitted windowed bootstrap never presents as complete', () => {
    const store = makeStore();
    try {
      const full = snapshot();
      store.bootstrapBegin({
        protocolVersion: full.protocolVersion,
        vaultId: full.vaultId,
        schemaEpoch: full.schemaEpoch,
        shapes: full.shapes,
      });
      store.bootstrapPage([full.rows[0]!]);
      // Simulates a crash before the final page: rows exist, but no cursor does,
      // so the replica is indistinguishable from one that never bootstrapped and
      // reads fail closed rather than returning a partial library.
      expect(store.status()).toEqual({ cursor: null, schemaEpoch: null });
      expect(() => store.read({ shapeId: 'shape-agenda', entity: 'core.event' })).toThrow(
        ReplicaRebootstrapRequiredError,
      );
    } finally {
      store.close();
    }
  });

  test('reopening a bootstrap discards the previous partial attempt', () => {
    const store = makeStore();
    try {
      const full = snapshot();
      const header = {
        protocolVersion: full.protocolVersion,
        vaultId: full.vaultId,
        schemaEpoch: full.schemaEpoch,
        shapes: full.shapes,
      };
      store.bootstrapBegin(header);
      store.bootstrapPage([full.rows[0]!]);
      store.bootstrapBegin(header);
      store.bootstrapPage([full.rows[1]!]);
      store.bootstrapCommit(full.cursor);
      expect(
        store.read({ shapeId: 'shape-agenda', entity: 'core.event' }).rows.map((row) => row.rowId),
      ).toEqual(['event-2']);
    } finally {
      store.close();
    }
  });

  test('rejects bootstrap pages and commits outside an open bootstrap', () => {
    const store = makeStore();
    try {
      expect(() => store.bootstrapPage([snapshot().rows[0]!])).toThrow(ReplicaProtocolError);
      expect(() => store.bootstrapCommit({ epoch: 'replica-1', seq: 2 })).toThrow(
        ReplicaProtocolError,
      );
      // A committed bootstrap closes its progress; a stray page must not reopen it.
      store.bootstrap(snapshot());
      expect(() => store.bootstrapPage([snapshot().rows[0]!])).toThrow(ReplicaProtocolError);
    } finally {
      store.close();
    }
  });

  test('rejects a windowed bootstrap for another vault before any row lands', () => {
    const store = makeStore();
    try {
      const full = snapshot();
      expect(() =>
        store.bootstrapBegin({
          protocolVersion: full.protocolVersion,
          vaultId: 'vault-other',
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        }),
      ).toThrow(ReplicaRebootstrapRequiredError);
    } finally {
      store.close();
    }
  });
}

describe('ReplicaSqliteStore core (sqlite-wasm driver)', () => {
  runStoreConformance(() => new SqliteReplicaStore(new sqlite3.oo1.DB(':memory:', 'c'), 'vault-a'));
});

describe('ReplicaSqliteStore core (node:sqlite driver)', () => {
  runStoreConformance(() => new ReplicaSqliteStore(new NodeSqliteDriver(), 'vault-a'));
});
