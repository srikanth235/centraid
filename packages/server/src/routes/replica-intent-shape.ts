/*
 * Pure intent-shape logic shared by every caller that admits an offline
 * intent against a consent-derived shape: the device-facing route
 * (`replica-intent-route.ts`) and the commons intent path. Shared so a
 * commons member's queued write is
 * checked for staleness with the EXACT SAME arithmetic a device's own
 * offline edit is — one answerer for "did this row change under you",
 * never two that could quietly disagree.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  currentReplicaLogState,
  operationReadSet,
  resolveEntity,
} from "@centraid/vault";

import {
  buildReplicaShapes,
  REPLICA_SYNTHETIC_PRIMARY_KEY,
  replicaWireRowId,
} from "./replica-shape.js";
import type { ReplicaShapeAccess } from "./replica-shape.js";

export interface ReplicaIntentBaseVersion {
  shapeId?: string;
  entity: string;
  rowId: string;
  version: number;
}

export interface ReplicaIntentConflict {
  shapeId?: string;
  entity: string;
  rowId: string;
  expectedVersion: number;
  actualVersion: number;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("intent input is not JSON-safe");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/**
 * The device path hashes `{action, appId, input, baseVersions?}`. Commons
 * uses a stable grant-scoped app id so a resent intent hashes identically
 * whichever transport delivered it.
 */
export function expectedPayloadHash(
  appId: string,
  action: string,
  input: unknown,
  baseVersions: readonly ReplicaIntentBaseVersion[],
  // THE CHAIN IS PART OF THE PAYLOAD (#996, R23). `dependsOn` decides WHEN an
  // intent runs and which rows its placeholders resolve to, so an intent whose
  // predecessors were rewritten in flight is a different intent. Omitted when
  // empty, exactly as `baseVersions` is, so an intent that names no chain
  // hashes as it always did.
  dependsOn: readonly string[] = []
): string {
  const canonical = canonicalJson({
    action,
    appId,
    input,
    ...(baseVersions.length > 0 ? { baseVersions } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  } as unknown as JsonValue);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** `dependsOn`: the intent ids this one may not run before (#996, R23). */
export function parseDependsOn(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("dependsOn must be an array of at most 100 intent ids");
  for (const item of value)
    if (typeof item !== "string" || item.length === 0)
      throw new Error("dependsOn contains an invalid intent id");
  // ORDER IS NOT MEANING: the ids are a SET of predecessors, all of which must
  // have executed. Sorting makes the hash independent of the order the outbox
  // happened to serialise them in.
  return [...(value as string[])].sort();
}

export function parseBaseVersions(value: unknown): ReplicaIntentBaseVersion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("baseVersions must be an array of at most 100 rows");
  const parsed = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("baseVersions contains an invalid row");
    const row = item as Record<string, unknown>;
    if (
      typeof row.entity !== "string" ||
      row.entity.length === 0 ||
      typeof row.rowId !== "string" ||
      row.rowId.length === 0 ||
      !Number.isSafeInteger(row.version) ||
      Number(row.version) < 0
    ) {
      throw new Error("baseVersions contains an invalid row");
    }
    if (row.shapeId !== undefined && typeof row.shapeId !== "string")
      throw new Error("baseVersions contains an invalid shape id");
    return {
      ...(row.shapeId === undefined ? {} : { shapeId: row.shapeId }),
      entity: row.entity,
      rowId: row.rowId,
      version: Number(row.version),
    };
  });
  return parsed.sort((left, right) =>
    `${left.entity}\u0000${left.rowId}\u0000${left.shapeId ?? ""}`.localeCompare(
      `${right.entity}\u0000${right.rowId}\u0000${right.shapeId ?? ""}`
    )
  );
}

/** A row the operation declared it read that the intent never referenced. */
export interface ReplicaIntentReadSetGap {
  operation: string;
  entity: string;
  rowId: string;
}

/**
 * THE DECLARED READ-SET IS PART OF THE CONFLICT CHECK (#996, rulings R6/R21/
 * R23). `baseVersions` used to be whatever the seat felt like sending: an
 * intent could reference the one row it edited, say nothing about the section
 * it was being filed into or the parent it was being nested under, and settle
 * against versions nobody had looked at. The operation declares what it reads;
 * an intent naming that operation must reference every one of those rows, and
 * a set short of it is refused rather than executed on a guess.
 *
 * An intent that names no operation is unchanged — the seat begins naming one
 * in W2, and this is the gate that will already be here when it does.
 */
export function missingReadSetVersions(
  operation: string | undefined,
  input: unknown,
  baseVersions: readonly ReplicaIntentBaseVersion[]
): ReplicaIntentReadSetGap[] {
  if (operation === undefined) return [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const referenced = new Set(
    baseVersions.map((base) => `${base.entity}\u0000${base.rowId}`)
  );
  return operationReadSet(operation, input as Record<string, unknown>)
    .filter(
      (entry) =>
        entry.id !== null && !referenced.has(`${entry.entity}\u0000${entry.id}`)
    )
    .map((entry) => ({
      operation,
      entity: entry.entity,
      rowId: entry.id as string,
    }));
}

/**
 * Durable proof that an intent crossed the canonical commit boundary —
 * shared so any retried intent replays
 * instead of re-running a possibly-already-committed command.
 */
export function hasCanonicalCommit(
  vault: DatabaseSync,
  intentId: string,
  finalization: "any" | "pending"
): boolean {
  return Boolean(
    vault
      .prepare(
        `SELECT 1
           FROM replica_invocation_commit
          WHERE intent_id = ?
            ${finalization === "pending" ? "AND journal_finalized_at IS NULL" : ""}
          LIMIT 1`
      )
      .get(intentId)
  );
}

/**
 * Resolve `baseVersions` against the CURRENT change log for the caller's own
 * consent-derived shape. `access` is whatever the caller already resolved
 * for itself — a device's ordinary shape access, or a commons member's
 * access — so opaque (HMAC) row ids resolve through the SAME
 * shape the caller reads through, never a raw guess at the underlying id.
 */
export function currentConflict(
  vault: DatabaseSync,
  access: ReplicaShapeAccess,
  baseVersions: readonly ReplicaIntentBaseVersion[]
): ReplicaIntentConflict | undefined {
  if (baseVersions.length === 0) return undefined;
  const epoch = currentReplicaLogState(vault).epoch;
  const shapes = buildReplicaShapes(vault, access);
  const shapesById = new Map(shapes.map((shape) => [shape.shapeId, shape]));
  for (const base of baseVersions) {
    let canonicalRowId = base.rowId;
    let resolvedShapeId = base.shapeId;
    const candidateShapes = base.shapeId
      ? [shapesById.get(base.shapeId)].filter((shape) => shape !== undefined)
      : shapes.filter((shape) => shape.entityMap.has(base.entity));
    const opaqueShapes = candidateShapes.filter(
      (shape) =>
        shape.entityMap.get(base.entity)?.primaryKey ===
        REPLICA_SYNTHETIC_PRIMARY_KEY
    );
    if (opaqueShapes.length > 0) {
      const candidates =
        base.version > 0
          ? (vault
              .prepare(
                `SELECT row_id FROM replica_change
                  WHERE epoch = ? AND entity = ? AND seq = ?`
              )
              .all(epoch, base.entity, base.version) as { row_id: string }[])
          : (vault
              .prepare(
                `SELECT DISTINCT row_id FROM replica_change
                  WHERE epoch = ? AND entity = ?`
              )
              .all(epoch, base.entity) as { row_id: string }[]);
      let resolved = false;
      for (const shape of opaqueShapes) {
        const match = candidates.find(
          (candidate) =>
            replicaWireRowId(shape, base.entity, candidate.row_id) ===
            base.rowId
        );
        if (match) {
          canonicalRowId = match.row_id;
          resolvedShapeId = shape.shapeId;
          resolved = true;
          break;
        }
      }
      if (!resolved && candidates.length > 0) {
        const entityMax = vault
          .prepare(
            `SELECT MAX(seq) AS seq FROM replica_change
              WHERE epoch = ? AND entity = ?`
          )
          .get(epoch, base.entity) as { seq: number | null };
        return {
          ...(resolvedShapeId === undefined
            ? {}
            : { shapeId: resolvedShapeId }),
          entity: base.entity,
          rowId: base.rowId,
          expectedVersion: base.version,
          actualVersion: entityMax.seq ?? 0,
        };
      }
      // A version-zero row with no matching current-epoch change is a valid
      // unchanged snapshot row. There is no canonical version to compare.
      if (!resolved) continue;
    }
    const actualVersion = currentRowVersion(
      vault,
      epoch,
      base.entity,
      canonicalRowId
    );
    if (actualVersion !== base.version) {
      return {
        ...(resolvedShapeId === undefined ? {} : { shapeId: resolvedShapeId }),
        entity: base.entity,
        rowId: base.rowId,
        expectedVersion: base.version,
        actualVersion,
      };
    }
  }
  return undefined;
}

/**
 * THE VERSION OF A ROW IS THE ROW'S OWN COLUMN (#996, R6).
 *
 * It used to be `MAX(seq)` over `replica_change` — the position of the last
 * projector entry that mentioned the row. That number is a property of the
 * TRANSPORT, not of the row: it moves when the log is pruned or the epoch is
 * bumped, it does not exist for a row the projector never covered, and a seat
 * holding `vault.db` whole has no way to compute it. `row_version` is on the
 * row, bumped by the row's own touch trigger, and it means the same thing on
 * the gateway and on the phone — which is the entire point of one vault, every
 * seat.
 *
 * ZERO IS "NOT THERE, OR NEVER TOUCHED". A row that has been deleted and a row
 * the intent invented answer the same way, and both are a conflict against any
 * base version above zero; `row_version` starts at 1 by CHECK, so zero can
 * never be a live row's answer.
 *
 * The epoch and the projector remain the fallback for an entity with no
 * `row_version` column — the append-only bands, which no intent bases a write
 * on but which a caller may still name.
 */
function currentRowVersion(
  vault: DatabaseSync,
  epoch: string,
  entity: string,
  rowId: string
): number {
  const ref = resolveEntity(entity, vault);
  if (ref && hasRowVersion(vault, ref.physical)) {
    const key = primaryKeyColumn(vault, ref.physical);
    if (key) {
      const row = vault
        .prepare(
          `SELECT row_version AS v FROM "${ref.physical}" WHERE "${key}" = ?`
        )
        .get(rowId) as { v: number } | undefined;
      return row?.v ?? 0;
    }
  }
  const fallback = vault
    .prepare(
      `SELECT MAX(seq) AS seq FROM replica_change
        WHERE epoch = ? AND entity = ? AND row_id = ?`
    )
    .get(epoch, entity, rowId) as { seq: number | null };
  return fallback.seq ?? 0;
}

const ROW_VERSION_CACHE = new WeakMap<DatabaseSync, Map<string, boolean>>();
const PRIMARY_KEY_CACHE = new WeakMap<
  DatabaseSync,
  Map<string, string | undefined>
>();

/** `PRAGMA table_info` per table, once per connection — this runs per row. */
function tableInfo(
  vault: DatabaseSync,
  physical: string
): { name: string; pk: number }[] {
  return vault.prepare(`PRAGMA table_info("${physical}")`).all() as {
    name: string;
    pk: number;
  }[];
}

function hasRowVersion(vault: DatabaseSync, physical: string): boolean {
  let cache = ROW_VERSION_CACHE.get(vault);
  if (!cache) {
    cache = new Map();
    ROW_VERSION_CACHE.set(vault, cache);
  }
  const hit = cache.get(physical);
  if (hit !== undefined) return hit;
  const answer = tableInfo(vault, physical).some(
    (column) => column.name === "row_version"
  );
  cache.set(physical, answer);
  return answer;
}

/** Single-column keys only: a composite key is not a `rowId`. */
function primaryKeyColumn(
  vault: DatabaseSync,
  physical: string
): string | undefined {
  let cache = PRIMARY_KEY_CACHE.get(vault);
  if (!cache) {
    cache = new Map();
    PRIMARY_KEY_CACHE.set(vault, cache);
  }
  if (cache.has(physical)) return cache.get(physical);
  const keys = tableInfo(vault, physical).filter((column) => column.pk > 0);
  const answer = keys.length === 1 ? keys[0]?.name : undefined;
  cache.set(physical, answer);
  return answer;
}
