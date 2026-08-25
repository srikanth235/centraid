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

import { currentReplicaLogState } from "@centraid/vault";

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
  baseVersions: readonly ReplicaIntentBaseVersion[]
): string {
  const canonical = canonicalJson({
    action,
    appId,
    input,
    ...(baseVersions.length > 0 ? { baseVersions } : {}),
  } as unknown as JsonValue);
  return crypto.createHash("sha256").update(canonical).digest("hex");
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
    const row = vault
      .prepare(
        `SELECT MAX(seq) AS seq FROM replica_change
          WHERE epoch = ? AND entity = ? AND row_id = ?`
      )
      .get(epoch, base.entity, canonicalRowId) as { seq: number | null };
    const actualVersion = row.seq ?? 0;
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
