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
  operationReadSet,
  producedRowKey,
  replicaPredecessorRowVersions,
  replicaRowIdsOf,
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
    compareBaseVersionKeys(baseVersionSortKey(left), baseVersionSortKey(right))
  );
}

function baseVersionSortKey(value: {
  entity: string;
  rowId: string;
  shapeId?: string;
}): string {
  return `${value.entity}\u0000${value.rowId}\u0000${value.shapeId ?? ""}`;
}

/**
 * CODE POINTS, NEVER A LOCALE (#1014, C20).
 *
 * The hash covers `baseVersions` IN THIS ORDER, and the seat computes its half
 * in `packages/client/src/replica/payload-hash.ts`. Both used to sort with
 * `localeCompare`, which is the runtime's ICU collation — Hermes, V8 and node
 * can order the same two keys differently, and a disagreement here is a
 * `replica_intent_hash_mismatch` on a perfectly well-formed write. `<`/`>` on
 * strings compares UTF-16 code units, which is a property of the string and
 * not of the machine; the client-side twin carries the same comment.
 */
function compareBaseVersionKeys(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
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
  baseVersions: readonly ReplicaIntentBaseVersion[],
  /**
   * The versions this intent's own predecessors produced (#1014, R18), keyed
   * by `producedRowKey`. A chained write states the version its seat OBSERVED
   * before the chain ran; by the time it executes, its parent has bumped the
   * row, so the number to check against is the parent's — see
   * `rebaseChainedBaseVersions`. Absent for an unchained intent, where the
   * seat's own number is the only one there is.
   */
  producedVersions?: ReadonlyMap<string, number>
): ReplicaIntentConflict | undefined {
  if (baseVersions.length === 0) return undefined;
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
      // EVERY ROW OF THE ENTITY, NEVER "the row the log touched at seq N"
      // (#996, R6). This used to narrow the candidates with
      // `seq = base.version`, which read the base version as a LOG POSITION —
      // and a base version is the row's `row_version` column now, so the
      // narrowing matched the wrong row or none at all. There is nothing to
      // narrow with: the wire id is an HMAC, and the only way back to the
      // canonical id is to hash the candidates.
      //
      // THE CANDIDATES ARE THE ENTITY'S ROWS, NOT THE LOG'S (#1014, G9). This
      // read `DISTINCT row_id FROM replica_change`, and then SKIPPED the check
      // entirely when that came back empty — so after any prune or epoch bump
      // every opaque-shape base version passed unconditionally. It failed
      // OPEN, on the one path whose whole job is to refuse a write made
      // against a row someone else has moved. The table cannot come back empty
      // for a row that exists, and a row that does not exist is version zero,
      // which is a conflict against any base version above it.
      const candidates = replicaRowIdsOf(vault, base.entity);
      let resolved = false;
      for (const shape of opaqueShapes) {
        const match = candidates.find(
          (candidate) =>
            replicaWireRowId(shape, base.entity, candidate) === base.rowId
        );
        if (match !== undefined) {
          canonicalRowId = match;
          resolvedShapeId = shape.shapeId;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        // NO CANDIDATE HASHES TO THIS WIRE ID: the row this intent names is
        // not in the shape — deleted, or never there. Zero, which is what
        // `replicaRowVersion` answers for the same fact, and in the same units
        // as `expectedVersion`. A base version of zero agrees with that and is
        // not a conflict; anything above it is.
        if (base.version === 0) continue;
        return {
          ...(resolvedShapeId === undefined
            ? {}
            : { shapeId: resolvedShapeId }),
          entity: base.entity,
          rowId: base.rowId,
          expectedVersion: base.version,
          actualVersion: 0,
        };
      }
    }
    const actualVersion = replicaRowVersion(vault, base.entity, canonicalRowId);
    // THE PARENT'S NUMBER WHEN THERE IS ONE (#1014, R18). `expectedVersion`
    // is reported as the number this check actually used, because that is
    // what the seat has to reconcile against — reporting the pre-chain one
    // would tell the member their edit was against a version the gateway
    // never compared.
    const expectedVersion = rebasedVersion(
      vault,
      base.entity,
      canonicalRowId,
      base.version,
      producedVersions
    );
    if (actualVersion !== expectedVersion) {
      return {
        ...(resolvedShapeId === undefined ? {} : { shapeId: resolvedShapeId }),
        entity: base.entity,
        rowId: base.rowId,
        expectedVersion,
        actualVersion,
      };
    }
  }
  return undefined;
}

/**
 * The conflict check for a base version that is ALREADY the origin's own
 * (#1014, V7).
 *
 * A member's signed envelope carries `entity`/`rowId` translated out of the
 * subscription lineage — `forwardOverPeer` states the ORIGIN's ids, because an
 * intent naming the audience's copy would address a row the origin does not
 * have. So there is nothing to resolve through a shape here, and resolving
 * anyway would be worse than nothing: the owner's own shapes are what
 * `buildReplicaShapes` returns on the origin, and one of them using a
 * synthetic primary key for this entity would send a perfectly good canonical
 * id down the opaque-hash path and report a conflict that is not there.
 *
 * The signed member intent had NO conflict check at all: `baseVersions` was
 * parsed and never used, so two members editing one shared album was last
 * writer wins, with the loser told nothing.
 */
export function originConflict(
  vault: DatabaseSync,
  baseVersions: readonly ReplicaIntentBaseVersion[]
): ReplicaIntentConflict | undefined {
  if (baseVersions.length === 0) return undefined;
  for (const base of baseVersions) {
    const actualVersion = replicaRowVersion(vault, base.entity, base.rowId);
    if (actualVersion !== base.version) {
      return {
        ...(base.shapeId === undefined ? {} : { shapeId: base.shapeId }),
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
 * The versions this intent's predecessors produced, ready for `currentConflict`.
 *
 * A thin, named wrapper so the two doors — the device door and the peer door —
 * arm the same rebase with one call each rather than each assembling it.
 */
export function rebaseChainedBaseVersions(
  vault: DatabaseSync,
  dependsOn: readonly string[]
): ReadonlyMap<string, number> | undefined {
  if (dependsOn.length === 0) return undefined;
  const produced = replicaPredecessorRowVersions(vault, dependsOn);
  return produced.size > 0 ? produced : undefined;
}

function rebasedVersion(
  vault: DatabaseSync,
  entity: string,
  canonicalRowId: string,
  observed: number,
  producedVersions: ReadonlyMap<string, number> | undefined
): number {
  if (!producedVersions) return observed;
  const ref = resolveEntity(entity, vault);
  if (!ref) return observed;
  return (
    producedVersions.get(producedRowKey(ref.physical, canonicalRowId)) ??
    observed
  );
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
 * THERE IS NO PROJECTOR FALLBACK LEFT (#1014, R-1014-1). An entity with no
 * `row_version` column — the append-only bands, which no intent bases a write
 * on but which a caller may still name — answers zero, the same as a row that
 * is not there. It used to answer `MAX(seq)` over the trigger log, which is
 * the R6 mistake wearing the word "fallback": a base version compared against
 * a transport position is not a weaker check, it is a check of the wrong
 * thing, and there is no longer a second log to take the number from.
 */
export function replicaRowVersion(
  vault: DatabaseSync,
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
  return 0;
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
