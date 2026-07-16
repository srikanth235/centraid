import { describe, expect, test, vi } from 'vitest';

import { ReplicaProtocolError, ReplicaRebootstrapRequiredError } from './errors.js';
import type { ReplicaFetcher } from './shell-transport.js';
import type {
  IntentOutcome,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaSnapshotRow,
} from './types.js';
import { runWindowedBootstrap, type WindowedBootstrapTarget } from './windowed-bootstrap.js';

import type { GatewayAuth } from '../gateway-auth.js';

const gatewayAuth: GatewayAuth = {
  baseUrl: 'http://127.0.0.1:18789',
  gatewayId: 'gateway-1',
  vaultId: 'vault-a',
};

const shapes = [
  {
    shapeId: 'shape-photos',
    appId: 'photos',
    purpose: 'dpv:ServiceProvision',
    entities: [
      {
        entity: 'core.content_item',
        primaryKey: 'content_id',
        columns: ['content_id', 'title'],
      },
    ],
  },
];

function row(id: string): ReplicaSnapshotRow {
  return {
    shapeId: 'shape-photos',
    entity: 'core.content_item',
    rowId: id,
    values: { content_id: id, title: id },
  };
}

/** Records the page-wise calls the driver makes so the walk can be asserted. */
function createTarget(): WindowedBootstrapTarget & {
  readonly rows: ReplicaSnapshotRow[];
  readonly applied: ReplicaChangeBatch[];
  header?: ReplicaBootstrapHeader;
  committedAt?: ReplicaCursor;
  committedOutcomes?: IntentOutcome[];
  cursor: ReplicaCursor;
} {
  const rows: ReplicaSnapshotRow[] = [];
  const applied: ReplicaChangeBatch[] = [];
  return {
    rows,
    applied,
    cursor: { epoch: 'replica-1', seq: 0 },
    async bootstrapBegin(header) {
      this.header = header;
      rows.length = 0;
    },
    async bootstrapPage(next) {
      rows.push(...next);
    },
    async bootstrapCommit(cursor, header, outcomes) {
      this.committedAt = cursor;
      this.header = header;
      this.committedOutcomes = outcomes ?? [];
      this.cursor = cursor;
      return cursor;
    },
    async applyChanges(batch) {
      applied.push(batch);
      for (const change of batch.changes) {
        if (change.op === 'delete') {
          const index = rows.findIndex((item) => item.rowId === change.rowId);
          if (index >= 0) rows.splice(index, 1);
        } else rows.push(change);
      }
      this.cursor = batch.to;
      return batch.to;
    },
  };
}

/** A fetcher serving scripted bootstrap pages keyed by the `after` token. */
function createFetcher(pages: Record<string, unknown>, status: Record<string, number> = {}) {
  const requests: string[] = [];
  const fetcher: ReplicaFetcher = (_baseUrl, pathname) => {
    requests.push(pathname);
    const after = new URL(pathname, 'http://x').searchParams.get('after') ?? '';
    const body = pages[after];
    const code = status[after] ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: 'missing_page' }), {
        status: code,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetcher, requests };
}

const emptyBatch = (cursor: ReplicaCursor): ReplicaChangeBatch => ({
  protocolVersion: 1,
  schemaEpoch: 'schema-1',
  from: cursor,
  to: cursor,
  changes: [],
});

describe('runWindowedBootstrap', () => {
  test('walks every page and applies all rows', async () => {
    const target = createTarget();
    const { fetcher, requests } = createFetcher({
      '': {
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-1',
        cursor: { epoch: 'replica-1', seq: 10 },
        shapes,
        rows: [row('photo-1')],
        complete: false,
        next: 'token-2',
      },
      'token-2': {
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-1',
        cursor: { epoch: 'replica-1', seq: 12 },
        rows: [row('photo-2')],
        complete: false,
        next: 'token-3',
      },
      'token-3': {
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-1',
        cursor: { epoch: 'replica-1', seq: 14 },
        rows: [row('photo-3')],
        complete: true,
      },
    });
    const pullChanges = vi.fn(async (cursor: ReplicaCursor) => emptyBatch(cursor));

    await runWindowedBootstrap({ gatewayAuth, target, fetcher, window: 1, pullChanges });

    expect(target.rows.map((item) => item.rowId)).toEqual(['photo-1', 'photo-2', 'photo-3']);
    expect(target.header?.shapes).toEqual(shapes);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain('window=1');
    expect(requests[1]).toContain('after=token-2');
  });

  test('commits at the page-1 cursor and replays the log from it', async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      '': {
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-1',
        cursor: { epoch: 'replica-1', seq: 10 },
        shapes,
        rows: [row('photo-1'), row('photo-2')],
        complete: false,
        next: 'token-2',
      },
      'token-2': {
        // A later page reads a LATER snapshot: photo-2 was deleted at seq 11 and
        // simply never appears again. Only the replay from the page-1 cursor can
        // remove the copy page 1 already handed us.
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-1',
        cursor: { epoch: 'replica-1', seq: 12 },
        rows: [row('photo-3')],
        complete: true,
      },
    });
    const batches: ReplicaChangeBatch[] = [
      {
        protocolVersion: 1,
        schemaEpoch: 'schema-1',
        from: { epoch: 'replica-1', seq: 10 },
        to: { epoch: 'replica-1', seq: 12 },
        changes: [
          {
            op: 'delete',
            shapeId: 'shape-photos',
            entity: 'core.content_item',
            rowId: 'photo-2',
          },
        ],
      },
    ];
    const pullChanges = vi.fn(
      async (cursor: ReplicaCursor) => batches.shift() ?? emptyBatch(cursor),
    );

    const cursor = await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher,
      window: 2,
      pullChanges,
    });

    // The crux: committed at page 1's cursor, and the delta pull started there.
    expect(target.committedAt).toEqual({ epoch: 'replica-1', seq: 10 });
    expect(pullChanges).toHaveBeenCalled();
    expect(pullChanges.mock.calls[0]?.[0]).toEqual({ epoch: 'replica-1', seq: 10 });
    // The deletion that slipped between per-page snapshots is repaired.
    expect(target.rows.map((item) => item.rowId)).toEqual(['photo-1', 'photo-3']);
    expect(cursor).toEqual({ epoch: 'replica-1', seq: 12 });
  });

  test('reconciles durable intent outcomes against the page-1 cursor', async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      '': {
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-1',
        cursor: { epoch: 'replica-1', seq: 10 },
        shapes,
        rows: [],
        complete: true,
      },
    });
    const reconcileOutcomes = vi.fn(async (_cursor: ReplicaCursor) => [
      { intentId: 'intent-1', status: 'executed' } as IntentOutcome,
    ]);

    await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher,
      reconcileOutcomes,
      pullChanges: async (cursor) => emptyBatch(cursor),
    });

    expect(reconcileOutcomes.mock.calls[0]?.[0]).toEqual({ epoch: 'replica-1', seq: 10 });
    expect(target.committedOutcomes).toEqual([{ intentId: 'intent-1', status: 'executed' }]);
  });

  test('surfaces a mid-pagination 409 as a rebootstrap so the walk restarts', async () => {
    const target = createTarget();
    const { fetcher } = createFetcher(
      {
        '': {
          protocolVersion: 1,
          vaultId: 'vault-a',
          schemaEpoch: 'schema-1',
          cursor: { epoch: 'replica-1', seq: 10 },
          shapes,
          rows: [row('photo-1')],
          complete: false,
          next: 'token-2',
        },
        'token-2': { error: 'replica_rebootstrap_required', reason: 'schema-changed' },
      },
      { 'token-2': 409 },
    );

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher,
        pullChanges: async (cursor) => emptyBatch(cursor),
      }),
    ).rejects.toThrow(ReplicaRebootstrapRequiredError);
    // Never committed: the partial walk cannot become a readable replica.
    expect(target.committedAt).toBeUndefined();
  });

  test('surfaces a malformed continuation token as a transport error', async () => {
    const target = createTarget();
    const { fetcher } = createFetcher(
      {
        '': {
          protocolVersion: 1,
          vaultId: 'vault-a',
          schemaEpoch: 'schema-1',
          cursor: { epoch: 'replica-1', seq: 10 },
          shapes,
          rows: [row('photo-1')],
          complete: false,
          next: 'token-bad',
        },
        'token-bad': { error: 'invalid_replica_bootstrap_token' },
      },
      { 'token-bad': 400 },
    );

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher,
        pullChanges: async (cursor) => emptyBatch(cursor),
      }),
    ).rejects.toMatchObject({ code: 'invalid_replica_bootstrap_token', status: 400 });
    expect(target.committedAt).toBeUndefined();
  });

  test('rejects a page whose identity drifts mid-walk', async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      '': {
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-1',
        cursor: { epoch: 'replica-1', seq: 10 },
        shapes,
        rows: [row('photo-1')],
        complete: false,
        next: 'token-2',
      },
      'token-2': {
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-2',
        cursor: { epoch: 'replica-1', seq: 12 },
        rows: [],
        complete: true,
      },
    });

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher,
        pullChanges: async (cursor) => emptyBatch(cursor),
      }),
    ).rejects.toThrow(ReplicaProtocolError);
    expect(target.committedAt).toBeUndefined();
  });

  test('rejects a page that claims completeness and a continuation at once', async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      '': {
        protocolVersion: 1,
        vaultId: 'vault-a',
        schemaEpoch: 'schema-1',
        cursor: { epoch: 'replica-1', seq: 10 },
        shapes,
        rows: [],
        complete: true,
        next: 'token-2',
      },
    });

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher,
        pullChanges: async (cursor) => emptyBatch(cursor),
      }),
    ).rejects.toThrow(ReplicaProtocolError);
  });
});
