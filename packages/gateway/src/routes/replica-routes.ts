// governance: allow-repo-hygiene file-size-limit (#406) one protocol route keeps bootstrap, pull/SSE, lazy-row, checkpoint, and intent admission semantics together
/* Replica HTTP protocol: authenticated bootstrap, pull/stream, lazy row and intent lanes. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  currentReplicaLogState,
  InvalidReplicaCursorError,
  parseReplicaCursor,
  readReplicaIntentOutcome,
  ReplicaRebootstrapRequiredError,
  withReplicaSnapshot,
  type ReplicaCursor,
  type ReplicaLogState,
  type ReplicaRow,
  type ReplicaSnapshotResult,
  type ReplicaSnapshotReader,
} from '@centraid/vault';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { EnrollmentStore } from '../serve/enrollment-store.js';
import { vaultContext } from '../serve/vault-context.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { readJson, sendJson } from './route-helpers.js';
import {
  expectedReplicaShapeIds,
  resolveReplicaAccess,
  type ReplicaRequestAccess,
} from './replica-access.js';
import { handleReplicaIntent, type ReplicaIntentDispatcher } from './replica-intent-route.js';
import {
  projectReplicaPage,
  replicaOutcomeWire,
  replicaShapeIds,
  sameReplicaShapeIds,
  type ReplicaProjectedPage,
} from './replica-projection.js';
import {
  buildReplicaShapes,
  replicaRowColumns,
  replicaShapesWire,
  REPLICA_MAX_VALUE_BYTES,
  REPLICA_PROTOCOL_VERSION,
  REPLICA_SYNTHETIC_PRIMARY_KEY,
  replicaWireRowId,
  shapeReplicaRow,
  type ReplicaEntityShape,
  type ReplicaServerShape,
} from './replica-shape.js';

const BOOTSTRAP_PATH = '/centraid/_vault/replica/bootstrap';
const CHANGES_PATH = '/centraid/_vault/changes';
const ROW_PATH = '/centraid/_vault/replica/row';
const CHECKPOINT_PATH = '/centraid/_vault/replica/checkpoint';
const OUTCOMES_PATH = '/centraid/_vault/replica/outcomes';
export const REPLICA_INTENTS_PATH = '/centraid/_vault/replica/intents';
const OUTCOME_RECONCILE_LIMIT = 500;
const DEFAULT_MAX_BOOTSTRAP_ROWS = 100_000;
const DEFAULT_MAX_SYNTHETIC_LOOKUP_ROWS = 25_000;

class ReplicaWorkLimitError extends Error {
  constructor(readonly kind: 'bootstrap' | 'synthetic-row') {
    super(`replica ${kind} work limit exceeded`);
    this.name = 'ReplicaWorkLimitError';
  }
}

type BootstrapValue = {
  shapes: ReplicaServerShape[];
  rows: NonNullable<ReturnType<typeof shapeReplicaRow>>[];
};

export interface ReplicaRouteOptions {
  enrollments?: EnrollmentStore;
  dispatchIntent: ReplicaIntentDispatcher;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  /** Authenticated-DoS bounds; overrides are used by focused route tests. */
  maxBootstrapRows?: number;
  maxSyntheticLookupRows?: number;
}

function rebootstrapBody(reason: string, state: ReplicaLogState): Record<string, unknown> {
  return {
    error: 'replica_rebootstrap_required',
    reason,
    state: {
      epoch: state.epoch,
      schemaEpoch: String(state.schemaEpoch),
      floor: state.floor,
      watermark: state.watermark,
      epochReason: state.epochReason,
    },
  };
}

function methodAllowed(res: ServerResponse, allowed: string): true {
  res.setHeader('Allow', allowed);
  return sendJson(res, 405, { error: 'method_not_allowed' });
}

function parseLimit(url: URL): number | undefined {
  const raw = url.searchParams.get('limit');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000 ? value : NaN;
}

function isSse(req: IncomingMessage, url: URL): boolean {
  return (
    url.searchParams.get('stream') === '1' ||
    String(req.headers.accept ?? '').includes('text/event-stream')
  );
}

function isNdjson(req: IncomingMessage): boolean {
  return String(req.headers.accept ?? '').includes('application/x-ndjson');
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sameCursor(left: ReplicaCursor, right: ReplicaCursor): boolean {
  return left.epoch === right.epoch && left.seq === right.seq;
}

function requestedColumns(url: URL): string[] {
  return [
    ...url.searchParams.getAll('column'),
    ...(url.searchParams.get('columns') ?? '').split(','),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function rawKeyValues(
  db: import('node:sqlite').DatabaseSync,
  schema: ReplicaEntityShape,
  rowId: string,
): unknown[] {
  const pk = (
    db.prepare(`PRAGMA table_info(${JSON.stringify(schema.physical)})`).all() as {
      name: string;
      pk: number;
    }[]
  )
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (pk.length === 1) return [rowId];
  const parsed = JSON.parse(rowId) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== pk.length)
    throw new Error('invalid replica row id');
  return parsed;
}

function rawValues(
  db: import('node:sqlite').DatabaseSync,
  schema: ReplicaEntityShape,
  rowId: string,
  columns: string[],
): Record<string, unknown> | undefined {
  const info = db.prepare(`PRAGMA table_info(${JSON.stringify(schema.physical)})`).all() as {
    name: string;
    pk: number;
  }[];
  const pk = info
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  const real = columns.filter((column) => column !== REPLICA_SYNTHETIC_PRIMARY_KEY);
  const selected = real.length > 0 ? real.map(quoteIdentifier).join(', ') : '1 AS __present';
  const where = pk.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
  const row = db
    .prepare(`SELECT ${selected} FROM ${quoteIdentifier(schema.physical)} WHERE ${where}`)
    .get(
      ...(rawKeyValues(db, schema, rowId) as (string | number | bigint | Uint8Array | null)[]),
    ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    const value = column === REPLICA_SYNTHETIC_PRIMARY_KEY ? rowId : row[column];
    values[column] =
      value instanceof Uint8Array
        ? { base64: Buffer.from(value).toString('base64'), byteSize: value.byteLength }
        : typeof value === 'bigint'
          ? value.toString()
          : value;
  }
  return values;
}

function rowForWireId(
  reader: ReplicaSnapshotReader,
  shape: ReplicaServerShape,
  schema: ReplicaEntityShape,
  entity: string,
  wireRowId: string,
  maxRows: number,
): ReplicaRow | undefined {
  if (schema.primaryKey !== REPLICA_SYNTHETIC_PRIMARY_KEY) {
    return reader.readRow(entity, wireRowId, { maxValueBytes: REPLICA_MAX_VALUE_BYTES });
  }
  let after: string | undefined;
  let scanned = 0;
  do {
    const page = reader.readRows(entity, {
      ...(after ? { after } : {}),
      limit: Math.min(10_000, Math.max(1, maxRows - scanned)),
      maxValueBytes: REPLICA_MAX_VALUE_BYTES,
    });
    const found = page.rows.find((row) => replicaWireRowId(shape, entity, row.rowId) === wireRowId);
    if (found) return found;
    scanned += page.rows.length;
    if (page.nextAfter && scanned >= maxRows) {
      throw new ReplicaWorkLimitError('synthetic-row');
    }
    after = page.nextAfter;
  } while (after);
  return undefined;
}

function accessFor(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  vaultId: string,
  enrollments?: EnrollmentStore,
): ReplicaRequestAccess | undefined {
  const resolution = resolveReplicaAccess(req, url, vaultId, enrollments);
  if (!resolution.ok) {
    sendJson(res, resolution.status, resolution.body);
    return undefined;
  }
  return resolution.access;
}

function sendProjected(
  res: ServerResponse,
  req: IncomingMessage,
  page: ReplicaProjectedPage,
): true {
  if (isNdjson(req)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.write(
      `${JSON.stringify({ type: 'meta', ...page.batch, changes: undefined, outcomes: undefined })}\n`,
    );
    for (const change of page.batch.changes)
      res.write(`${JSON.stringify({ type: 'change', change })}\n`);
    for (const outcome of page.batch.outcomes ?? [])
      res.write(`${JSON.stringify({ type: 'outcome', outcome })}\n`);
    res.end(
      `${JSON.stringify({ type: 'cursor', cursor: page.batch.to, hasMore: page.batch.hasMore ?? false })}\n`,
    );
    return true;
  }
  return sendJson(res, 200, page.batch);
}

function parseSince(url: URL): ReplicaCursor {
  const since = url.searchParams.get('since');
  if (since === null) throw new InvalidReplicaCursorError('replica since cursor is required');
  if (since === '0:0') throw new InvalidReplicaCursorError('replica bootstrap sentinel');
  return parseReplicaCursor(since);
}

function parseOutcomeReconciliation(body: Record<string, unknown>): {
  intentIds: string[];
  through: ReplicaCursor;
} {
  if (
    !Array.isArray(body.intentIds) ||
    body.intentIds.length > OUTCOME_RECONCILE_LIMIT ||
    body.intentIds.some(
      (intentId) => typeof intentId !== 'string' || intentId.length < 1 || intentId.length > 512,
    ) ||
    body.through === null ||
    typeof body.through !== 'object' ||
    Array.isArray(body.through)
  ) {
    throw new Error(`intentIds must contain at most ${OUTCOME_RECONCILE_LIMIT} valid ids`);
  }
  return {
    intentIds: [...new Set(body.intentIds as string[])],
    through: parseReplicaCursor(body.through as ReplicaCursor),
  };
}

function sendSseRebootstrap(res: ServerResponse, reason: string, state: ReplicaLogState): void {
  writeSse(res, 'rebootstrap', rebootstrapBody(reason, state));
  res.end();
}

async function streamChanges(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: import('node:sqlite').DatabaseSync,
  vaultId: string,
  options: ReplicaRouteOptions,
  limit: number,
): Promise<true> {
  const rawSince = url.searchParams.get('since');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  if (rawSince === '0:0') {
    sendSseRebootstrap(res, 'initial', currentReplicaLogState(db));
    return true;
  }
  let cursor: ReplicaCursor;
  try {
    cursor = parseSince(url);
  } catch (error) {
    writeSse(res, 'rebootstrap', {
      error: 'replica_rebootstrap_required',
      reason: error instanceof Error ? error.message : 'invalid-cursor',
    });
    res.end();
    return true;
  }
  const expected = expectedReplicaShapeIds(url);
  let baseline = expected;
  let closed = false;
  const close = () => {
    closed = true;
  };
  req.on('close', close);
  res.on('close', close);
  let heartbeatAt = Date.now();
  while (!closed) {
    const access = resolveReplicaAccess(req, url, vaultId, options.enrollments);
    if (!access.ok) {
      sendSseRebootstrap(res, 'device-access-changed', currentReplicaLogState(db));
      break;
    }
    try {
      const page = projectReplicaPage(db, access.access, cursor, limit);
      if (page.rebootstrapReason || (baseline && !sameReplicaShapeIds(page.shapes, baseline))) {
        sendSseRebootstrap(
          res,
          page.rebootstrapReason ?? 'shape-changed',
          currentReplicaLogState(db),
        );
        break;
      }
      baseline ??= replicaShapeIds(page.shapes);
      if (page.doorbell.length > 0) {
        writeSse(res, 'change', { changes: page.doorbell, cursor: page.batch.to });
      }
      if (!sameCursor(cursor, page.batch.to)) writeSse(res, 'cursor', page.batch.to);
      cursor = page.batch.to;
      if (page.batch.hasMore) continue;
    } catch (error) {
      if (error instanceof ReplicaRebootstrapRequiredError) {
        sendSseRebootstrap(res, error.reason, error.state);
        break;
      }
      writeSse(res, 'retry', {
        error: 'replica_stream_retry',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (Date.now() - heartbeatAt >= (options.heartbeatMs ?? 15_000)) {
      res.write(': heartbeat\n\n');
      heartbeatAt = Date.now();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 250));
  }
  req.off('close', close);
  res.off('close', close);
  if (!closed && !res.writableEnded) res.end();
  return true;
}

export function makeReplicaRouteHandler(
  vaults: VaultRegistry,
  options: ReplicaRouteOptions,
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (
      ![
        BOOTSTRAP_PATH,
        CHANGES_PATH,
        ROW_PATH,
        CHECKPOINT_PATH,
        OUTCOMES_PATH,
        REPLICA_INTENTS_PATH,
      ].includes(url.pathname)
    )
      return false;
    const plane = vaults.current();
    const vaultId = vaultContext()?.vaultId ?? plane.boot.vaultId;
    const access = accessFor(req, res, url, vaultId, options.enrollments);
    if (!access) return true;
    const method = (req.method ?? 'GET').toUpperCase();

    if (url.pathname === OUTCOMES_PATH) {
      if (method !== 'POST') return methodAllowed(res, 'POST');
      let requested: ReturnType<typeof parseOutcomeReconciliation>;
      try {
        requested = parseOutcomeReconciliation(await readJson(req));
      } catch (error) {
        return sendJson(res, 400, {
          error: 'invalid_replica_outcome_reconciliation',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const snapshot = withReplicaSnapshot(plane.db.vault, (reader) => {
        if (requested.through.epoch !== reader.state.epoch) {
          return { reason: 'epoch-mismatch' as const, outcomes: [] };
        }
        if (
          requested.through.seq < reader.state.floor.seq ||
          requested.through.seq > reader.state.watermark.seq
        ) {
          return { reason: 'cursor-gap' as const, outcomes: [] };
        }
        const outcomes = requested.intentIds.flatMap((intentId) => {
          const latest = plane.db.vault
            .prepare(
              `SELECT MAX(seq) AS seq FROM replica_change
                WHERE epoch = ? AND entity = 'replica.intent' AND row_id = ?`,
            )
            .get(reader.state.epoch, intentId) as { seq: number | null };
          // A transition newer than the bootstrap watermark remains visible
          // through incremental pull and must not clear its overlay early.
          if (latest.seq !== null && latest.seq > requested.through.seq) return [];
          const outcome = readReplicaIntentOutcome(plane.db.vault, intentId, access.deviceId);
          if (!outcome || (access.appId && outcome.appId !== access.appId)) return [];
          const wire = replicaOutcomeWire(outcome);
          return wire ? [wire] : [];
        });
        return { outcomes };
      });
      if ('reason' in snapshot.value && snapshot.value.reason) {
        return sendJson(res, 409, rebootstrapBody(snapshot.value.reason, snapshot.state));
      }
      return sendJson(res, 200, {
        protocolVersion: REPLICA_PROTOCOL_VERSION,
        outcomes: snapshot.value.outcomes,
      });
    }

    if (url.pathname === BOOTSTRAP_PATH) {
      if (method !== 'GET') return methodAllowed(res, 'GET');
      let snapshot: ReplicaSnapshotResult<BootstrapValue>;
      try {
        snapshot = withReplicaSnapshot(plane.db.vault, (reader) => {
          const nowMs = Date.now();
          const shapes = buildReplicaShapes(plane.db.vault, access, new Date(nowMs).toISOString());
          const cache = new Map<string, ReplicaRow[]>();
          const rowsFor = (entity: string): ReplicaRow[] => {
            const found = cache.get(entity);
            if (found) return found;
            const rows: ReplicaRow[] = [];
            let after: string | undefined;
            do {
              const page = reader.readRows(entity, {
                ...(after ? { after } : {}),
                limit: 10_000,
                maxValueBytes: REPLICA_MAX_VALUE_BYTES,
              });
              rows.push(...page.rows);
              if (rows.length > (options.maxBootstrapRows ?? DEFAULT_MAX_BOOTSTRAP_ROWS)) {
                throw new ReplicaWorkLimitError('bootstrap');
              }
              after = page.nextAfter;
            } while (after);
            cache.set(entity, rows);
            return rows;
          };
          const rows = shapes.flatMap((shape) =>
            shape.entities.flatMap((entity) =>
              rowsFor(entity.entity).flatMap((row) => {
                const shaped = shapeReplicaRow(shape, entity.entity, row, nowMs);
                return shaped ? [shaped] : [];
              }),
            ),
          );
          return { shapes, rows };
        });
      } catch (error) {
        if (error instanceof ReplicaWorkLimitError && error.kind === 'bootstrap') {
          return sendJson(res, 413, { error: 'replica_bootstrap_too_large' });
        }
        throw error;
      }
      if (access.appId && snapshot.value.shapes.length === 0)
        return sendJson(res, 403, { error: 'replica_shape_empty' });
      return sendJson(res, 200, {
        protocolVersion: REPLICA_PROTOCOL_VERSION,
        vaultId,
        schemaEpoch: String(snapshot.state.schemaEpoch),
        cursor: snapshot.state.watermark,
        shapes: replicaShapesWire(snapshot.value.shapes),
        shapeIds: replicaShapeIds(snapshot.value.shapes),
        rows: snapshot.value.rows,
        trust: access.trust,
        rememberDevice: access.rememberDevice,
      });
    }

    if (url.pathname === CHANGES_PATH) {
      if (method !== 'GET') return methodAllowed(res, 'GET');
      const limit = parseLimit(url);
      if (Number.isNaN(limit)) return sendJson(res, 400, { error: 'invalid_replica_limit' });
      if (isSse(req, url))
        return streamChanges(req, res, url, plane.db.vault, vaultId, options, limit ?? 1_000);
      if (url.searchParams.get('since') === '0:0')
        return sendJson(
          res,
          409,
          rebootstrapBody('initial', currentReplicaLogState(plane.db.vault)),
        );
      try {
        const page = projectReplicaPage(plane.db.vault, access, parseSince(url), limit ?? 1_000);
        const expected = expectedReplicaShapeIds(url);
        if (page.rebootstrapReason || (expected && !sameReplicaShapeIds(page.shapes, expected))) {
          return sendJson(
            res,
            409,
            rebootstrapBody(
              page.rebootstrapReason ?? 'shape-changed',
              currentReplicaLogState(plane.db.vault),
            ),
          );
        }
        return sendProjected(res, req, page);
      } catch (error) {
        if (error instanceof ReplicaRebootstrapRequiredError)
          return sendJson(res, 409, rebootstrapBody(error.reason, error.state));
        if (error instanceof InvalidReplicaCursorError || error instanceof RangeError)
          return sendJson(res, 400, { error: 'invalid_replica_cursor', message: error.message });
        throw error;
      }
    }

    if (url.pathname === ROW_PATH) {
      if (method !== 'GET') return methodAllowed(res, 'GET');
      const shapeId = url.searchParams.get('shapeId') ?? '';
      const entity = url.searchParams.get('entity') ?? '';
      const rowId = url.searchParams.get('rowId') ?? url.searchParams.get('row_id') ?? '';
      const columns = requestedColumns(url);
      if (!shapeId || !entity || !rowId)
        return sendJson(res, 400, { error: 'invalid_replica_row_request' });
      try {
        const result = withReplicaSnapshot(plane.db.vault, (reader) => {
          const nowMs = Date.now();
          const shape = buildReplicaShapes(
            plane.db.vault,
            access,
            new Date(nowMs).toISOString(),
          ).find((candidate) => candidate.shapeId === shapeId);
          const schema = shape?.entityMap.get(entity);
          const row =
            shape && schema
              ? rowForWireId(
                  reader,
                  shape,
                  schema,
                  entity,
                  rowId,
                  options.maxSyntheticLookupRows ?? DEFAULT_MAX_SYNTHETIC_LOOKUP_ROWS,
                )
              : undefined;
          if (!shape || !schema || !row) return undefined;
          const allowed = replicaRowColumns(shape, entity, row, nowMs);
          if (!allowed) return undefined;
          if (columns.length === 0) return shapeReplicaRow(shape, entity, row, nowMs);
          if (columns.some((column) => !allowed.has(column))) throw new Error('field_not_in_shape');
          const values = rawValues(plane.db.vault, schema, row.rowId, columns);
          return values ? { shapeId, entity, rowId, values } : undefined;
        });
        if (!result.value) return sendJson(res, 404, { error: 'replica_row_not_found' });
        return sendJson(res, 200, {
          protocolVersion: REPLICA_PROTOCOL_VERSION,
          schemaEpoch: String(result.state.schemaEpoch),
          cursor: result.state.watermark,
          row: result.value,
        });
      } catch (error) {
        if (error instanceof ReplicaWorkLimitError && error.kind === 'synthetic-row') {
          return sendJson(res, 413, { error: 'replica_row_lookup_too_large' });
        }
        if (error instanceof Error && error.message === 'field_not_in_shape')
          return sendJson(res, 403, { error: 'replica_field_not_in_shape' });
        return sendJson(res, 400, { error: 'invalid_replica_row_request' });
      }
    }

    if (url.pathname === CHECKPOINT_PATH) {
      if (method !== 'POST') return methodAllowed(res, 'POST');
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'malformed_request' });
      }
      const rawCursor = body.cursor;
      const rawSchema = body.schemaEpoch;
      if (!rawCursor || typeof rawCursor !== 'object')
        return sendJson(res, 400, { error: 'invalid_replica_checkpoint' });
      try {
        const cursor = parseReplicaCursor(rawCursor as ReplicaCursor);
        const schemaEpoch = Number(rawSchema);
        const state = currentReplicaLogState(plane.db.vault);
        if (
          !Number.isSafeInteger(schemaEpoch) ||
          schemaEpoch !== state.schemaEpoch ||
          cursor.epoch !== state.epoch ||
          cursor.seq < state.floor.seq ||
          cursor.seq > state.watermark.seq
        ) {
          return sendJson(res, 409, rebootstrapBody('checkpoint-incompatible', state));
        }
        if (!access.deviceKey || !options.enrollments)
          return sendJson(res, 200, { ok: true, persisted: false, cursor });
        // The server offering a snapshot is not an acknowledgement: only the
        // client POST after its SQLite commit initializes/replaces an epoch.
        // Within one epoch, acknowledgements remain strictly monotonic.
        const previous = options.enrollments.get(access.deviceKey, vaultId)?.checkpoint;
        const checkpoint =
          !previous || previous.epoch !== cursor.epoch || previous.schemaEpoch !== schemaEpoch
            ? options.enrollments.resetCheckpoint(access.deviceKey, vaultId, {
                ...cursor,
                schemaEpoch,
              })
            : options.enrollments.advanceCheckpoint(access.deviceKey, vaultId, {
                ...cursor,
                schemaEpoch,
              });
        return sendJson(res, 200, { ok: true, persisted: true, checkpoint });
      } catch (error) {
        return sendJson(res, 409, {
          error: 'replica_checkpoint_conflict',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (method !== 'POST') return methodAllowed(res, 'POST');
    return handleReplicaIntent(req, res, { plane, access, dispatch: options.dispatchIntent });
  };
}
