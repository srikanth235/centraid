import type { DatabaseSync } from 'node:sqlite';
import {
  readReplicaChanges,
  readReplicaIntentOutcome,
  withReplicaSnapshot,
  type ReplicaChangeEntry,
  type ReplicaCursor,
} from '@centraid/vault';
import {
  buildReplicaShapes,
  REPLICA_MAX_VALUE_BYTES,
  REPLICA_PROTOCOL_VERSION,
  replicaHistoricalRowState,
  replicaWireRowId,
  shapeReplicaRow,
  type ReplicaServerShape,
  type ReplicaShapeAccess,
} from './replica-shape.js';

export interface ReplicaUpsertWire {
  op: 'upsert';
  shapeId: string;
  entity: string;
  rowId: string;
  values: Record<string, unknown>;
  oversizedFields?: string[];
}

export interface ReplicaDeleteWire {
  op: 'delete';
  shapeId: string;
  entity: string;
  rowId: string;
}

export type ReplicaChangeWire = ReplicaUpsertWire | ReplicaDeleteWire;

export interface ReplicaIntentOutcomeWire {
  intentId: string;
  status: 'parked' | 'executed' | 'denied' | 'failed';
  reason?: string;
}

export interface ReplicaChangeBatchWire {
  protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  schemaEpoch: string;
  from: ReplicaCursor;
  to: ReplicaCursor;
  changes: ReplicaChangeWire[];
  outcomes?: ReplicaIntentOutcomeWire[];
  hasMore?: boolean;
  /** Current shape ids let transports detect trust/expiry changes. */
  shapeIds: string[];
}

export interface ReplicaDoorbellChange {
  seq: number;
  entity: string;
  rowId: string;
  op: ReplicaChangeEntry['op'];
  changedAt: string;
  /** Exact authorized shapes affected by this opaque wake-up. */
  shapeIds: string[];
}

export interface ReplicaProjectedPage {
  batch: ReplicaChangeBatchWire;
  doorbell: ReplicaDoorbellChange[];
  shapes: ReplicaServerShape[];
  rebootstrapReason?: 'shape-changed';
}

// Any of these rows can change which entities, predicates or columns a
// client is entitled to retain. Advancing past one as ordinary data would
// leave a stale local shape behind, so the transport requires a bootstrap.
const SHAPE_CONTROL_ENTITIES = new Set([
  'consent.app',
  'consent.app_ext',
  'consent.access_grant',
  'consent.grant_scope',
  'consent.policy',
]);

const WIRE_OUTCOMES = new Set(['parked', 'executed', 'denied', 'failed']);

function outcomeWire(
  outcome: NonNullable<ReturnType<typeof readReplicaIntentOutcome>>,
): ReplicaIntentOutcomeWire | undefined {
  if (!WIRE_OUTCOMES.has(outcome.status)) return undefined;
  return {
    intentId: outcome.intentId,
    status: outcome.status as ReplicaIntentOutcomeWire['status'],
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

export function replicaOutcomeWire(
  outcome: NonNullable<ReturnType<typeof readReplicaIntentOutcome>>,
): ReplicaIntentOutcomeWire | undefined {
  return outcomeWire(outcome);
}

export function replicaShapeIds(shapes: readonly ReplicaServerShape[]): string[] {
  return shapes.map((shape) => shape.shapeId).sort();
}

export function sameReplicaShapeIds(
  shapes: readonly ReplicaServerShape[],
  expected: readonly string[],
): boolean {
  const actual = replicaShapeIds(shapes);
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((value, index) => value === wanted[index]);
}

function rowKey(entity: string, rowId: string): string {
  return `${entity}\u0000${rowId}`;
}

function changeKey(shapeId: string, entity: string, rowId: string): string {
  return `${shapeId}\u0000${entity}\u0000${rowId}`;
}

function oldValues(change: ReplicaChangeEntry): Record<string, unknown> | undefined {
  if (!change.oldValuesJson) return undefined;
  try {
    const parsed = JSON.parse(change.oldValuesJson) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function activeAt(row: Record<string, unknown> | undefined, now: string): boolean {
  return (
    row?.status === 'active' &&
    row.revoked_at === null &&
    (row.expires_at === null || (typeof row.expires_at === 'string' && row.expires_at > now))
  );
}

function appMatches(
  db: DatabaseSync,
  access: ReplicaShapeAccess,
  appId: unknown,
  appName?: unknown,
): boolean {
  if (typeof appId !== 'string') return false;
  if (!access.appId) return true;
  if (access.appId === appId || access.appId === appName) return true;
  return (
    db
      .prepare(`SELECT 1 AS matched FROM consent_app WHERE app_id = ? AND name = ? LIMIT 1`)
      .get(appId, access.appId) !== undefined
  );
}

function currentRow(
  db: DatabaseSync,
  table: string,
  key: string,
  rowId: string,
): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM "${table}" WHERE "${key}" = ?`).get(rowId) as
    | Record<string, unknown>
    | undefined;
}

function shapeControlChange(
  db: DatabaseSync,
  access: ReplicaShapeAccess,
  change: ReplicaChangeEntry,
  now: string,
): boolean {
  const before = oldValues(change);
  if (change.entity === 'core.concept') {
    const restriction = access.appId ? ` AND (a.app_id = ? OR a.name = ?)` : '';
    return (
      db
        .prepare(
          `SELECT 1 AS matched
             FROM consent_access_grant g
             JOIN consent_app a ON a.app_id = g.app_id
            WHERE g.purpose_concept_id = ? AND a.status = 'active'
              AND g.status = 'active' AND g.revoked_at IS NULL
              AND (g.expires_at IS NULL OR g.expires_at > ?)${restriction}
            LIMIT 1`,
        )
        .get(change.rowId, now, ...(access.appId ? [access.appId, access.appId] : [])) !== undefined
    );
  }
  if (!SHAPE_CONTROL_ENTITIES.has(change.entity)) return false;
  if (change.entity === 'consent.policy') {
    const after = currentRow(db, 'consent_policy', 'policy_id', change.rowId);
    return [before, after].some(
      (row) => typeof row?.effective_from === 'string' && row.effective_from <= now,
    );
  }
  if (change.entity === 'consent.app') {
    const after = currentRow(db, 'consent_app', 'app_id', change.rowId);
    return [before, after].some(
      (row) => row?.status === 'active' && appMatches(db, access, row.app_id, row.name),
    );
  }
  if (change.entity === 'consent.access_grant') {
    const after = currentRow(db, 'consent_access_grant', 'grant_id', change.rowId);
    return [before, after].some((row) => activeAt(row, now) && appMatches(db, access, row?.app_id));
  }
  if (change.entity === 'consent.grant_scope') {
    const after = currentRow(db, 'consent_grant_scope', 'scope_id', change.rowId);
    for (const grantId of new Set(
      [before?.grant_id, after?.grant_id].filter(
        (value): value is string => typeof value === 'string',
      ),
    )) {
      const grant = currentRow(db, 'consent_access_grant', 'grant_id', grantId);
      if (activeAt(grant, now) && appMatches(db, access, grant?.app_id)) return true;
    }
    return false;
  }
  let keyAppId: unknown;
  try {
    const key = JSON.parse(change.rowId) as unknown;
    if (Array.isArray(key)) keyAppId = key[0];
  } catch {
    // Invalid internal row ids fail closed below.
  }
  return appMatches(db, access, before?.app_id ?? keyAppId);
}

interface CoalescedChange {
  first: ReplicaChangeEntry;
  last: ReplicaChangeEntry;
}

/**
 * Project one stable metadata page through current consent. The SQLite read
 * transaction pins the log watermark and all changed-row reads together.
 */
export function projectReplicaPage(
  db: DatabaseSync,
  access: ReplicaShapeAccess & { deviceId?: string },
  since: ReplicaCursor,
  limit = 1_000,
): ReplicaProjectedPage {
  return withReplicaSnapshot(db, (reader) => {
    const nowMs = Date.now();
    const shapes = buildReplicaShapes(db, access, new Date(nowMs).toISOString());
    const page = readReplicaChanges(db, { since, limit });
    const shapeIds = replicaShapeIds(shapes);
    const rebootstrap = (): ReplicaProjectedPage => ({
      shapes,
      doorbell: [],
      rebootstrapReason: 'shape-changed',
      batch: {
        protocolVersion: REPLICA_PROTOCOL_VERSION,
        schemaEpoch: String(page.schemaEpoch),
        from: since,
        to: page.next,
        changes: [],
        shapeIds,
        ...(page.hasMore ? { hasMore: true } : {}),
      },
    });
    const sampledNow = new Date(nowMs).toISOString();
    if (page.changes.some((change) => shapeControlChange(db, access, change, sampledNow))) {
      return rebootstrap();
    }

    const rows = new Map<string, ReturnType<typeof reader.readRow>>();
    const rowFor = (entity: string, rowId: string) => {
      const key = rowKey(entity, rowId);
      if (!rows.has(key)) {
        rows.set(key, reader.readRow(entity, rowId, { maxValueBytes: REPLICA_MAX_VALUE_BYTES }));
      }
      return rows.get(key);
    };
    const changes = new Map<string, ReplicaChangeWire>();
    const outcomes = new Map<string, ReplicaIntentOutcomeWire>();
    const doorbell: ReplicaDoorbellChange[] = [];

    const coalesced = new Map<string, CoalescedChange>();
    for (const raw of page.changes) {
      if (raw.entity === 'replica.intent') {
        if (!access.deviceId) continue;
        const outcome = readReplicaIntentOutcome(db, raw.rowId, access.deviceId);
        if (!outcome || (access.appId && outcome.appId !== access.appId)) continue;
        const wire = outcomeWire(outcome);
        if (!wire) continue;
        outcomes.set(wire.intentId, wire);
        const outcomeShapeIds = shapes
          .filter((shape) => shape.appId === outcome.appId)
          .map((shape) => shape.shapeId)
          .sort();
        doorbell.push({
          seq: raw.seq,
          entity: raw.entity,
          rowId: raw.rowId,
          op: raw.op,
          changedAt: raw.changedAt,
          shapeIds: outcomeShapeIds,
        });
        continue;
      }

      const key = rowKey(raw.entity, raw.rowId);
      const existing = coalesced.get(key);
      coalesced.set(
        key,
        existing ? { first: existing.first, last: raw } : { first: raw, last: raw },
      );
    }

    for (const { first, last } of coalesced.values()) {
      const interested = shapes.filter((shape) => shape.entityMap.has(last.entity));
      if (interested.length === 0) continue;
      const row = last.op === 'delete' ? undefined : rowFor(last.entity, last.rowId);
      const affected = new Map<string, { op: ReplicaChangeEntry['op']; shapeIds: string[] }>();
      for (const shape of interested) {
        const previous =
          first.op === 'insert'
            ? { known: true }
            : replicaHistoricalRowState(shape, last.entity, first.oldValuesJson);
        if (!previous.known) return rebootstrap();
        const shaped = row ? shapeReplicaRow(shape, last.entity, row, nowMs) : undefined;
        if (!previous.columns && !shaped) continue;
        const rowId = shaped?.rowId ?? replicaWireRowId(shape, last.entity, last.rowId);
        const wire: ReplicaChangeWire = shaped
          ? { op: 'upsert', ...shaped }
          : { op: 'delete', shapeId: shape.shapeId, entity: last.entity, rowId };
        const projectedOp = wire.op === 'delete' ? 'delete' : last.op;
        const affectedKey = `${rowId}\u0000${projectedOp}`;
        const wake = affected.get(affectedKey) ?? { op: projectedOp, shapeIds: [] };
        wake.shapeIds.push(shape.shapeId);
        affected.set(affectedKey, wake);
        changes.set(changeKey(shape.shapeId, last.entity, last.rowId), wire);
      }
      for (const [key, wake] of affected) {
        const rowId = key.slice(0, key.lastIndexOf('\u0000'));
        doorbell.push({
          seq: last.seq,
          entity: last.entity,
          rowId,
          op: wake.op,
          changedAt: last.changedAt,
          shapeIds: wake.shapeIds.sort(),
        });
      }
    }

    return {
      shapes,
      doorbell,
      batch: {
        protocolVersion: REPLICA_PROTOCOL_VERSION,
        schemaEpoch: String(page.schemaEpoch),
        from: since,
        to: page.next,
        changes: [...changes.values()],
        ...(outcomes.size > 0 ? { outcomes: [...outcomes.values()] } : {}),
        ...(page.hasMore ? { hasMore: true } : {}),
        shapeIds,
      },
    };
  }).value;
}
