import {
  runWindowedBootstrap,
  type WindowedBootstrapTarget,
} from '../../packages/client/src/replica/windowed-bootstrap.js';
import type { ReplicaFetcher } from '../../packages/client/src/replica/shell-transport.js';
import type {
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaSnapshotRow,
} from '../../packages/client/src/replica/types.js';

const gatewayAuth = {
  baseUrl: 'http://127.0.0.1:18789',
  gatewayId: 'quality-lane',
  vaultId: 'volume-vault',
};

export async function exerciseWindowedBootstrap(
  source: ReplicaSnapshotRow[],
  window: number,
  deletionIndex?: number,
): Promise<{ durationMs: number; rows: number; cursor: ReplicaCursor }> {
  const stored = new Map<string, ReplicaSnapshotRow>();
  const target: WindowedBootstrapTarget = {
    async bootstrapBegin() {
      stored.clear();
    },
    async bootstrapPage(rows) {
      for (const row of rows) stored.set(row.rowId, row);
    },
    async bootstrapCommit(cursor) {
      return cursor;
    },
    async applyChanges(batch) {
      for (const change of batch.changes) {
        if (change.op === 'delete') stored.delete(change.rowId);
        else stored.set(change.rowId, change);
      }
      return batch.to;
    },
  };
  const fetcher: ReplicaFetcher = (_baseUrl, pathname) => {
    const params = new URL(pathname, 'http://quality.local').searchParams;
    const offset = Number(params.get('after') ?? 0);
    const rows = source.slice(offset, offset + window);
    const next = offset + rows.length;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          vaultId: 'volume-vault',
          schemaEpoch: 'schema-1',
          cursor: { epoch: 'volume-epoch', seq: 10 },
          ...(offset === 0
            ? {
                shapes: [
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
                ],
              }
            : {}),
          rows,
          complete: next >= source.length,
          ...(next < source.length ? { next: String(next) } : {}),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  let sentDeletion = deletionIndex === undefined;
  const pullChanges = (cursor: ReplicaCursor): Promise<ReplicaChangeBatch> => {
    if (!sentDeletion && deletionIndex !== undefined) {
      sentDeletion = true;
      return Promise.resolve({
        protocolVersion: 1,
        schemaEpoch: 'schema-1',
        from: cursor,
        to: { epoch: cursor.epoch, seq: cursor.seq + 1 },
        changes: [
          {
            op: 'delete',
            shapeId: 'shape-photos',
            entity: 'core.content_item',
            rowId: source[deletionIndex]?.rowId ?? `missing-${deletionIndex}`,
          },
        ],
      });
    }
    return Promise.resolve({
      protocolVersion: 1,
      schemaEpoch: 'schema-1',
      from: cursor,
      to: cursor,
      changes: [],
    });
  };

  const started = performance.now();
  const cursor = await runWindowedBootstrap({
    gatewayAuth,
    target,
    fetcher,
    window,
    pullChanges,
  });
  return { durationMs: performance.now() - started, rows: stored.size, cursor };
}
