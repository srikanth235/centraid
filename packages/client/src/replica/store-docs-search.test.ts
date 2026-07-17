// The core.document local-search spec (offline Docs search) — split from
// store-core.test.ts to keep that conformance suite under the repo file cap.
import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, test } from 'vitest';

import { NodeSqliteDriver } from './node-sqlite-test-driver.js';
import { SqliteReplicaStore } from './sqlite-store.js';
import { ReplicaSqliteStore } from './store-core.js';

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function runDocsSearch(makeStore: () => ReplicaSqliteStore): void {
  test('indexes core.document titles for offline Docs search on bootstrap and delta', () => {
    const store = makeStore();
    try {
      store.bootstrap({
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-docs',
        cursor: { epoch: 'replica-docs', seq: 1 },
        shapes: [
          {
            shapeId: 'shape-docs',
            appId: 'docs',
            purpose: 'dpv:ServiceProvision',
            entities: [
              {
                entity: 'core.document',
                primaryKey: 'document_id',
                columns: ['document_id', 'title', 'deleted_at', 'updated_at'],
              },
            ],
          },
        ],
        rows: [
          {
            shapeId: 'shape-docs',
            entity: 'core.document',
            rowId: 'doc-lease',
            values: {
              document_id: 'doc-lease',
              title: 'Apartment lease agreement',
              deleted_at: null,
              updated_at: '2026-07-15T10:00:00.000Z',
            },
          },
        ],
      });
      // Bootstrap-installed row is searchable offline.
      const bootstrapped = store.search({
        shapeId: 'shape-docs',
        entity: 'core.document',
        query: 'lease',
      });
      expect(bootstrapped.rows.map((row) => row.values.document_id)).toEqual(['doc-lease']);

      // A delta-arriving document is indexed the same way.
      store.applyChanges({
        protocolVersion: 1,
        schemaEpoch: 'schema-docs',
        from: { epoch: 'replica-docs', seq: 1 },
        to: { epoch: 'replica-docs', seq: 2 },
        changes: [
          {
            op: 'upsert',
            shapeId: 'shape-docs',
            entity: 'core.document',
            rowId: 'doc-invoice',
            values: {
              document_id: 'doc-invoice',
              title: 'Quarterly invoice',
              deleted_at: null,
              updated_at: '2026-07-16T10:00:00.000Z',
            },
          },
        ],
      });
      expect(
        store
          .search({ shapeId: 'shape-docs', entity: 'core.document', query: 'invoice' })
          .rows.map((row) => row.values.document_id),
      ).toEqual(['doc-invoice']);

      // A trashed document (deleted_at set) drops out of the offline index.
      store.applyChanges({
        protocolVersion: 1,
        schemaEpoch: 'schema-docs',
        from: { epoch: 'replica-docs', seq: 2 },
        to: { epoch: 'replica-docs', seq: 3 },
        changes: [
          {
            op: 'upsert',
            shapeId: 'shape-docs',
            entity: 'core.document',
            rowId: 'doc-lease',
            values: {
              document_id: 'doc-lease',
              title: 'Apartment lease agreement',
              deleted_at: '2026-07-17T10:00:00.000Z',
              updated_at: '2026-07-17T10:00:00.000Z',
            },
          },
        ],
      });
      expect(
        store.search({ shapeId: 'shape-docs', entity: 'core.document', query: 'lease' }).rows,
      ).toHaveLength(0);
    } finally {
      store.close();
    }
  });
}

describe('core.document search spec (sqlite-wasm driver)', () => {
  runDocsSearch(() => new SqliteReplicaStore(new sqlite3.oo1.DB(':memory:', 'c'), 'vault-a'));
});

describe('core.document search spec (node:sqlite driver)', () => {
  runDocsSearch(() => new ReplicaSqliteStore(new NodeSqliteDriver(), 'vault-a'));
});
