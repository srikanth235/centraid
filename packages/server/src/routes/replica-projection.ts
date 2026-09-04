import type { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_REPLICA_TEXT_CEILING_BYTES,
  readReplicaChanges,
  readReplicaIntentOutcome,
  withReplicaSnapshot,
} from "@centraid/vault";
import type {
  ReplicaChangeEntry,
  ReplicaCursor,
  ReplicaRow,
} from "@centraid/vault";

import {
  buildReplicaShapes,
  REPLICA_PROTOCOL_VERSION,
  replicaHistoricalRowState,
  replicaRowColumns,
  replicaWireRowId,
  shapeReplicaRow,
} from "./replica-shape.js";
import type {
  ReplicaRowWire,
  ReplicaServerShape,
  ReplicaShapeAccess,
} from "./replica-shape.js";
import { preparedStatement } from "./sql-statement-cache.js";

export interface ReplicaUpsertWire {
  op: "upsert";
  commitId: string;
  shapeId: string;
  entity: string;
  rowId: string;
  values: Record<string, unknown>;
  rowVersion?: number;
  oversizedFields?: string[];
}

export interface ReplicaDeleteWire {
  op: "delete";
  commitId: string;
  rowVersion: number;
  shapeId: string;
  entity: string;
  rowId: string;
}

export type ReplicaChangeWire = ReplicaUpsertWire | ReplicaDeleteWire;

export interface ReplicaIntentOutcomeWire {
  intentId: string;
  status: "parked" | "executed" | "denied" | "failed" | "conflict";
  reason?: string;
  conflict?: {
    shapeId?: string;
    entity: string;
    rowId: string;
    expectedVersion: number;
    actualVersion: number;
  };
}

export interface ReplicaChangeBatchWire {
  protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  schemaEpoch: string;
  from: ReplicaCursor;
  to: ReplicaCursor;
  changes: ReplicaChangeWire[];
  outcomes?: ReplicaIntentOutcomeWire[];
  hasMore?: boolean;
  /** Lets transports detect trust/expiry changes. */
  shapeIds: string[];
}

export interface ReplicaDoorbellChange {
  seq: number;
  commitId: string;
  entity: string;
  rowId: string;
  op: ReplicaChangeEntry["op"];
  changedAt: string;
  /** The authorized shapes this opaque wake-up affects. */
  shapeIds: string[];
}

export interface ReplicaProjectedPage {
  batch: ReplicaChangeBatchWire;
  doorbell: ReplicaDoorbellChange[];
  shapes: ReplicaServerShape[];
  rebootstrapReason?: "shape-changed";
}

// These rows change what a client may retain: advancing past one as ordinary
// data leaves a stale local shape behind. Two survive #928's AP-apps-declare,
// because a shape is now a function of the install register and the sealed
// registry alone: `access.app` says whether an app is installed and carries
// the key its row ids are derived from, and `access.app_ext` carries an ext
// band's declared sealed columns.
//
// The verdict below reads the ENTRY, not the row's end state: an app that was
// installed, revoked, then installed again must force a bootstrap for the
// middle transition too. Retention compaction therefore may not fold these
// entries away — `REPLICA_COMPACTION_HELD_ENTITIES` covers this set.
export const SHAPE_CONTROL_ENTITIES = new Set(["access.app", "access.app_ext"]);

const WIRE_OUTCOMES = new Set([
  "parked",
  "executed",
  "denied",
  "failed",
  "conflict",
]);

function outcomeWire(
  outcome: NonNullable<ReturnType<typeof readReplicaIntentOutcome>>
): ReplicaIntentOutcomeWire | undefined {
  if (!WIRE_OUTCOMES.has(outcome.status)) return undefined;
  return {
    intentId: outcome.intentId,
    status: outcome.status as ReplicaIntentOutcomeWire["status"],
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.conflict === undefined ? {} : { conflict: outcome.conflict }),
  };
}

export function replicaOutcomeWire(
  outcome: NonNullable<ReturnType<typeof readReplicaIntentOutcome>>
): ReplicaIntentOutcomeWire | undefined {
  return outcomeWire(outcome);
}

export function replicaShapeIds(
  shapes: readonly ReplicaServerShape[]
): string[] {
  return shapes.map((shape) => shape.shapeId).sort();
}

export function sameReplicaShapeIds(
  shapes: readonly ReplicaServerShape[],
  expected: readonly string[]
): boolean {
  const actual = replicaShapeIds(shapes);
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((value, index) => value === wanted[index])
  );
}

function rowKey(entity: string, rowId: string): string {
  return `${entity}\u0000${rowId}`;
}

function changeKey(shapeId: string, entity: string, rowId: string): string {
  return `${shapeId}\u0000${entity}\u0000${rowId}`;
}

function oldValues(
  change: ReplicaChangeEntry
): Record<string, unknown> | undefined {
  if (!change.oldValuesJson) return undefined;
  try {
    const parsed = JSON.parse(change.oldValuesJson) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function appMatches(
  db: DatabaseSync,
  access: ReplicaShapeAccess,
  appId: unknown,
  appName?: unknown
): boolean {
  if (typeof appId !== "string") return false;
  if (!access.appId) return true;
  if (access.appId === appId || access.appId === appName) return true;
  return (
    preparedStatement(
      db,
      `SELECT 1 AS matched FROM access_app WHERE app_id = ? AND name = ? LIMIT 1`
    ).get(appId, access.appId) !== undefined
  );
}

function currentRow(
  db: DatabaseSync,
  table: string,
  key: string,
  rowId: string
): Record<string, unknown> | undefined {
  // Table/key come from a closed set of install-register tables, never the wire.
  return preparedStatement(
    db,
    `SELECT * FROM "${table}" WHERE "${key}" = ?`
  ).get(rowId) as Record<string, unknown> | undefined;
}

function shapeControlChange(
  db: DatabaseSync,
  access: ReplicaShapeAccess,
  change: ReplicaChangeEntry
): boolean {
  if (!SHAPE_CONTROL_ENTITIES.has(change.entity)) return false;
  const before = oldValues(change);
  if (change.entity === "access.app") {
    const after = currentRow(db, "access_app", "app_id", change.rowId);
    return [before, after].some(
      (row) =>
        row?.status === "active" && appMatches(db, access, row.app_id, row.name)
    );
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

export interface ReplicaProjectionOptions {
  /**
   * The caller sends `doorbell` and drops `batch.changes` (the multiplex plane,
   * where each vault's rows travel over its own lane). Visibility and the wire
   * row id are still computed; only the shaped `values` copy is skipped.
   */
  doorbellOnly?: boolean;
}

interface ShapedChangeRow {
  rowId: string;
  wire?: ReplicaRowWire;
}

function shapedChangeRow(
  shape: ReplicaServerShape,
  entity: string,
  row: ReplicaRow,
  nowMs: number,
  doorbellOnly: boolean
): ShapedChangeRow | undefined {
  if (!doorbellOnly) {
    const wire = shapeReplicaRow(shape, entity, row, nowMs);
    return wire ? { rowId: wire.rowId, wire } : undefined;
  }
  // `shapeReplicaRow`'s predicate + field-mask pass, minus the `values` copy.
  return replicaRowColumns(shape, entity, row, nowMs)
    ? { rowId: replicaWireRowId(shape, entity, row.rowId) }
    : undefined;
}

/**
 * One stable metadata page through current consent: the read transaction pins
 * the watermark and every changed-row read together.
 */
export function projectReplicaPage(
  db: DatabaseSync,
  access: ReplicaShapeAccess & { deviceId?: string },
  since: ReplicaCursor,
  limit = 1_000,
  options: ReplicaProjectionOptions = {}
): ReplicaProjectedPage {
  const doorbellOnly = options.doorbellOnly ?? false;
  return withReplicaSnapshot(db, (reader) => {
    const nowMs = Date.now();
    const shapes = buildReplicaShapes(
      db,
      access,
      new Date(nowMs).toISOString()
    );
    const page = readReplicaChanges(db, { since, limit });
    const shapeIds = replicaShapeIds(shapes);
    const rebootstrap = (): ReplicaProjectedPage => ({
      shapes,
      doorbell: [],
      rebootstrapReason: "shape-changed",
      batch: {
        protocolVersion: REPLICA_PROTOCOL_VERSION,
        schemaEpoch: String(page.schemaEpoch),
        from: since,
        to: page.next,
        changes: [],
        ...(page.hasMore ? { hasMore: true } : {}),
        shapeIds,
      },
    });
    if (page.changes.some((change) => shapeControlChange(db, access, change))) {
      return rebootstrap();
    }

    const rows = new Map<string, ReturnType<typeof reader.readRow>>();
    const rowFor = (entity: string, rowId: string) => {
      const key = rowKey(entity, rowId);
      if (!rows.has(key)) {
        rows.set(
          key,
          reader.readRow(entity, rowId, {
            maxValueBytes: DEFAULT_REPLICA_TEXT_CEILING_BYTES,
          })
        );
      }
      return rows.get(key);
    };
    const changes = new Map<string, ReplicaChangeWire>();
    const outcomes = new Map<string, ReplicaIntentOutcomeWire>();
    const doorbell: ReplicaDoorbellChange[] = [];

    const coalesced = new Map<string, CoalescedChange>();
    for (const raw of page.changes) {
      if (raw.entity === "replica.intent") {
        if (!access.deviceId) continue;
        const outcome = readReplicaIntentOutcome(
          db,
          raw.rowId,
          access.deviceId
        );
        if (!outcome || (access.appId && outcome.appId !== access.appId))
          continue;
        const wire = outcomeWire(outcome);
        if (!wire) continue;
        outcomes.set(wire.intentId, wire);
        const outcomeShapeIds = shapes
          .filter((shape) => shape.appId === outcome.appId)
          .map((shape) => shape.shapeId)
          .sort();
        doorbell.push({
          seq: raw.seq,
          commitId: raw.commitId,
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
        existing
          ? { first: existing.first, last: raw }
          : { first: raw, last: raw }
      );
    }

    for (const { first, last } of coalesced.values()) {
      const interested = shapes.filter((shape) =>
        shape.entityMap.has(last.entity)
      );
      if (interested.length === 0) continue;
      const row =
        last.op === "delete" ? undefined : rowFor(last.entity, last.rowId);
      const affected = new Map<
        string,
        { op: ReplicaChangeEntry["op"]; shapeIds: string[] }
      >();
      for (const shape of interested) {
        // The PRIOR pair, never `first.op`/`first.oldValuesJson`: compaction
        // may have folded older entries into `first`, and membership at the
        // client's cursor is decided by the state before the OLDEST change
        // `first` stands for (#883 C6). An unfolded entry reports itself.
        const previous =
          first.priorOp === "insert"
            ? { known: true }
            : replicaHistoricalRowState(
                shape,
                last.entity,
                first.priorOldValuesJson
              );
        if (!previous.known) return rebootstrap();
        const shaped = row
          ? shapedChangeRow(shape, last.entity, row, nowMs, doorbellOnly)
          : undefined;
        if (!previous.columns && !shaped) continue;
        const rowId =
          shaped?.rowId ?? replicaWireRowId(shape, last.entity, last.rowId);
        if (!doorbellOnly) {
          const wire: ReplicaChangeWire = shaped?.wire
            ? { op: "upsert", commitId: last.commitId, ...shaped.wire }
            : {
                op: "delete",
                commitId: last.commitId,
                rowVersion: last.seq,
                shapeId: shape.shapeId,
                entity: last.entity,
                rowId,
              };
          changes.set(changeKey(shape.shapeId, last.entity, last.rowId), wire);
        }
        // A row no longer visible projects as a delete however the log
        // recorded it; a visible one keeps the log's own op.
        const projectedOp = shaped ? last.op : "delete";
        const affectedKey = `${rowId}\u0000${projectedOp}`;
        const wake = affected.get(affectedKey) ?? {
          op: projectedOp,
          shapeIds: [],
        };
        wake.shapeIds.push(shape.shapeId);
        affected.set(affectedKey, wake);
      }
      for (const [key, wake] of affected) {
        const rowId = key.slice(0, key.lastIndexOf("\u0000"));
        doorbell.push({
          seq: last.seq,
          commitId: last.commitId,
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
