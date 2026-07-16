// governance: allow-repo-hygiene file-size-limit pre-existing cohesive SQLite regression suite; decomposition is outside issue #417
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, test } from 'vitest';

import {
  OnlineOnlyError,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
} from './errors.js';
import { SqliteReplicaStore } from './sqlite-store.js';
import { REPLICA_SYNTHETIC_PRIMARY_KEY } from './types.js';
import type { ReplicaChangeBatch, ReplicaSnapshot } from './types.js';

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function openStore(): { store: SqliteReplicaStore; db: Database } {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  return { store: new SqliteReplicaStore(db, 'vault-a'), db };
}

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
      {
        shapeId: 'shape-search-agenda',
        appId: 'agenda',
        purpose: 'dpv:ServiceProvision',
        entities: [
          {
            entity: 'core.event',
            primaryKey: 'event_id',
            columns: ['event_id', 'summary', 'description', 'status'],
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
      {
        shapeId: 'shape-search-agenda',
        entity: 'core.event',
        rowId: 'event-search',
        values: {
          event_id: 'event-search',
          summary: 'Quarterly budget review',
          description: 'Bring the forecast',
          status: 'confirmed',
        },
      },
    ],
  };
}

describe('SqliteReplicaStore', () => {
  test('destructively rebuilds incompatible v0 replica schemas', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    db.exec(`
      CREATE TABLE replica_shape (
        shape_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL
      );
      INSERT INTO replica_shape(shape_id, app_id) VALUES ('stale-shape', 'agenda');
      PRAGMA user_version = 0;
    `);

    const store = new SqliteReplicaStore(db, 'vault-a');
    try {
      expect(store.status()).toEqual({ cursor: null, schemaEpoch: null });
      expect(store.catalog()).toEqual([]);
      expect(
        db.exec({
          sql: 'PRAGMA user_version',
          rowMode: 'object',
          returnValue: 'resultRows',
        }),
      ).toEqual([{ user_version: 4 }]);
      expect(
        db
          .exec({
            sql: 'PRAGMA table_info(replica_shape)',
            rowMode: 'object',
            returnValue: 'resultRows',
          })
          .map((column) => (column as { name: string }).name),
      ).toContain('purpose');
    } finally {
      store.close();
    }
  });

  test('atomically bootstraps a shape and executes bounded local reads', () => {
    const { store } = openStore();
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

  test('never commits a snapshot containing an undisclosed field', () => {
    const { store, db } = openStore();
    try {
      store.bootstrap(snapshot());
      const invalid = snapshot();
      invalid.cursor = { epoch: 'replica-2', seq: 0 };
      invalid.rows[0]!.values.secret = 'plaintext';
      expect(() => store.bootstrap(invalid)).toThrow(ReplicaProtocolError);
      expect(store.status().cursor).toEqual({ epoch: 'replica-1', seq: 2 });
      expect(store.read({ shapeId: 'shape-agenda', entity: 'core.event' }).rows).toHaveLength(2);
      expect(JSON.stringify(store.catalog())).not.toContain('secret');
      expect(
        JSON.stringify(
          db.exec({
            sql: 'SELECT * FROM replica_entity_schema',
            rowMode: 'object',
            returnValue: 'resultRows',
          }),
        ),
      ).not.toContain('secret');
    } finally {
      store.close();
    }
  });

  test('accepts a string row id for a canonical numeric primary-key value', () => {
    const { store } = openStore();
    try {
      const numeric = snapshot();
      numeric.rows = [
        {
          ...numeric.rows[0]!,
          rowId: '1',
          values: { ...numeric.rows[0]!.values, event_id: 1 },
        },
      ];
      expect(store.bootstrap(numeric)).toEqual(numeric.cursor);
      expect(store.read({ shapeId: 'shape-agenda', entity: 'core.event' }).rows[0]).toMatchObject({
        rowId: '1',
        values: { event_id: 1 },
      });
    } finally {
      store.close();
    }
  });

  test('rolls back a whole change batch when any change is invalid', () => {
    const { store } = openStore();
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
          {
            op: 'delete',
            shapeId: 'shape-agenda',
            entity: 'missing.entity',
            rowId: 'missing',
          },
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
    const { store } = openStore();
    try {
      store.bootstrap(snapshot());
      const applied = store.applyChanges({
        protocolVersion: 1,
        schemaEpoch: 'schema-1',
        from: { epoch: 'replica-1', seq: 2 },
        to: { epoch: 'replica-1', seq: 3 },
        changes: [
          {
            op: 'delete',
            shapeId: 'shape-agenda',
            entity: 'core.event',
            rowId: 'event-1',
          },
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
    const { store } = openStore();
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

  test('searches all eager photo captions even when the normal library window excludes a row', () => {
    const { store } = openStore();
    try {
      store.bootstrap(searchableSnapshot());
      expect(
        store.read({
          shapeId: 'shape-photos',
          entity: 'core.content_item',
          orderBy: { column: 'created_at', dir: 'desc' },
          limit: 1,
        }).rows[0]?.rowId,
      ).toBe('photo-new');
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

  test('keeps airplane-mode Agenda search current with incremental replica changes', () => {
    const { store } = openStore();
    try {
      store.bootstrap(searchableSnapshot());
      expect(
        store.search({
          shapeId: 'shape-search-agenda',
          entity: 'core.event',
          query: 'budg',
        }).rows[0]?.values.event_id,
      ).toBe('event-search');

      store.applyChanges({
        protocolVersion: 1,
        schemaEpoch: 'schema-search',
        from: { epoch: 'replica-search', seq: 1 },
        to: { epoch: 'replica-search', seq: 2 },
        changes: [
          {
            op: 'upsert',
            shapeId: 'shape-search-agenda',
            entity: 'core.event',
            rowId: 'event-search',
            values: {
              event_id: 'event-search',
              summary: 'Pottery workshop',
              description: 'Bring an apron',
              status: 'confirmed',
            },
          },
        ],
      });
      expect(
        store.search({
          shapeId: 'shape-search-agenda',
          entity: 'core.event',
          query: 'budget',
        }).rows,
      ).toHaveLength(0);
      expect(
        store.search({
          shapeId: 'shape-search-agenda',
          entity: 'core.event',
          query: 'pottery',
        }).rows,
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test('mirrors exposed-key ties and fails an opaque tie at the LIMIT boundary', () => {
    const { store } = openStore();
    try {
      const exposed = searchableSnapshot();
      exposed.rows[0]!.values.title = 'Same caption';
      exposed.rows[1]!.values.title = 'Same caption';
      exposed.rows.reverse();
      store.bootstrap(exposed);
      expect(
        store.search({
          shapeId: 'shape-photos',
          entity: 'core.content_item',
          query: 'same',
          limit: 1,
        }).rows[0]?.rowId,
      ).toBe('photo-new');

      const opaque = searchableSnapshot();
      const schema = opaque.shapes[0]!.entities[0]!;
      schema.primaryKey = REPLICA_SYNTHETIC_PRIMARY_KEY;
      schema.columns.push(REPLICA_SYNTHETIC_PRIMARY_KEY);
      for (const row of opaque.rows.filter((candidate) => candidate.shapeId === 'shape-photos')) {
        row.values.title = 'Same caption';
        row.values[REPLICA_SYNTHETIC_PRIMARY_KEY] = row.rowId;
      }
      store.bootstrap(opaque);
      expect(() =>
        store.search({
          shapeId: 'shape-photos',
          entity: 'core.content_item',
          query: 'same',
          limit: 1,
        }),
      ).toThrow(OnlineOnlyError);
    } finally {
      store.close();
    }
  });

  test('fails incomplete and unsupported local search features online-only', () => {
    const { store } = openStore();
    try {
      const complete = searchableSnapshot();
      complete.shapes[1]!.entities.push({
        entity: 'knowledge.note',
        primaryKey: 'note_id',
        columns: ['note_id', 'title', 'body_content_id'],
      });
      complete.rows.push({
        shapeId: 'shape-search-agenda',
        entity: 'knowledge.note',
        rowId: 'note-1',
        values: { note_id: 'note-1', title: 'Budget', body_content_id: 'body-1' },
      });
      store.bootstrap(complete);
      expect(() =>
        store.search({
          shapeId: 'shape-search-agenda',
          entity: 'core.event',
          query: 'budget',
          where: [{ column: 'status', op: 'eq', value: 'confirmed' }],
        }),
      ).toThrow(OnlineOnlyError);
      expect(() =>
        store.search({
          shapeId: 'shape-search-agenda',
          entity: 'knowledge.note',
          query: 'budget',
        }),
      ).toThrow(OnlineOnlyError);

      const incomplete = searchableSnapshot();
      delete incomplete.rows[2]!.values.description;
      incomplete.rows[2]!.oversizedFields = ['description'];
      store.bootstrap(incomplete);
      expect(() =>
        store.search({
          shapeId: 'shape-search-agenda',
          entity: 'core.event',
          query: 'budget',
        }),
      ).toThrow(OnlineOnlyError);
    } finally {
      store.close();
    }
  });

  test('epoch mismatch wipes canonical state and requires a new snapshot', () => {
    const { store } = openStore();
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
});
