import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  currentReplicaLogState,
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
} from "@centraid/vault";
import type { ReplicaIntentOutcome } from "@centraid/vault";

import { canWrite } from "../serve/enrollment-store.js";
import { runWithReplicaIntent } from "../serve/replica-intent-context.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { replicaOutcomeWire } from "./replica-projection.js";
import {
  buildReplicaShapes,
  REPLICA_SYNTHETIC_PRIMARY_KEY,
  REPLICA_PROTOCOL_VERSION,
  replicaWireRowId,
} from "./replica-shape.js";
import type { ReplicaShapeAccess } from "./replica-shape.js";
import { readJson, sendJson } from "./route-helpers.js";

export interface ReplicaIntentDispatchInput {
  intentId: string;
  appId: string;
  action: string;
  input: unknown;
  baseVersions?: ReplicaIntentBaseVersion[];
}

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

export type ReplicaIntentDispatchOutcome =
  | { status: "executed"; output?: unknown }
  | {
      status: "parked";
      invocationId?: string;
      reason?: string;
      output?: unknown;
    }
  | { status: "denied" | "failed"; reason: string; output?: unknown }
  | { status: "retryable"; reason?: string };

export type ReplicaIntentDispatcher = (
  input: ReplicaIntentDispatchInput
) => Promise<ReplicaIntentDispatchOutcome>;

export interface ReplicaIntentRouteContext {
  plane: VaultPlane;
  access: ReplicaShapeAccess & { deviceId: string; memberId?: string };
  dispatch: ReplicaIntentDispatcher;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
const NO_TRANSIENT_OUTPUT = Symbol("no transient replica output");

function canonicalJson(value: JsonValue): string {
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

function expectedPayloadHash(
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

function parseBaseVersions(value: unknown): ReplicaIntentBaseVersion[] {
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

function currentConflict(
  plane: VaultPlane,
  access: ReplicaShapeAccess,
  baseVersions: readonly ReplicaIntentBaseVersion[]
): ReplicaIntentConflict | undefined {
  if (baseVersions.length === 0) return undefined;
  const epoch = currentReplicaLogState(plane.db.vault).epoch;
  // Opaque shape identities are HMACs of the canonical primary key. Resolve
  // them only through the server's consent-derived shape and the change log;
  // treating the wire token as a raw row id would make an offline edit appear
  // conflict-free whenever the row had changed since the device's snapshot.
  const shapes = buildReplicaShapes(plane.db.vault, access);
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
          ? (plane.db.vault
              .prepare(
                `SELECT row_id FROM replica_change
                  WHERE epoch = ? AND entity = ? AND seq = ?`
              )
              .all(epoch, base.entity, base.version) as { row_id: string }[])
          : (plane.db.vault
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
        const entityMax = plane.db.vault
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
    const row = plane.db.vault
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

function sameIdentity(
  outcome: ReplicaIntentOutcome,
  input: {
    deviceId: string;
    appId: string;
    action: string;
    payloadHash: string;
  }
): boolean {
  return (
    outcome.deviceId === input.deviceId &&
    outcome.appId === input.appId &&
    outcome.action === input.action &&
    outcome.payloadHash === input.payloadHash
  );
}

function sendOutcome(
  res: ServerResponse,
  outcome: ReplicaIntentOutcome,
  transientOutput: unknown | typeof NO_TRANSIENT_OUTPUT = NO_TRANSIENT_OUTPUT
): true {
  const wire = replicaOutcomeWire(outcome);
  if (!wire) {
    return sendJson(res, 202, {
      protocolVersion: REPLICA_PROTOCOL_VERSION,
      accepted: true,
      outcome: { intentId: outcome.intentId, status: "in-flight" },
    });
  }
  return sendJson(res, wire.status === "parked" ? 202 : 200, {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    outcome:
      transientOutput === NO_TRANSIENT_OUTPUT
        ? wire
        : { ...wire, output: transientOutput },
  });
}

function concealIdentityConflict(res: ServerResponse, intentId: string): true {
  // UUID collisions are not actionable by the submitting device. Use the
  // ordinary in-flight acknowledgement so another device's durable row is
  // not exposed as an existence oracle, and leave that row untouched.
  return sendJson(res, 202, {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    accepted: true,
    outcome: { intentId, status: "in-flight" },
  });
}

/** Durable proof that an intent crossed the canonical commit boundary. */
function hasCanonicalCommit(
  plane: VaultPlane,
  intentId: string,
  finalization: "any" | "pending"
): boolean {
  return Boolean(
    plane.db.vault
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

/** Authenticated, durable, device-scoped offline intent admission. */
export async function handleReplicaIntent(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReplicaIntentRouteContext
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: "malformed_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const intentId = typeof body.intentId === "string" ? body.intentId : "";
  const appId = typeof body.appId === "string" ? body.appId : "";
  const action = typeof body.action === "string" ? body.action : "";
  const payloadHash =
    typeof body.payloadHash === "string" ? body.payloadHash : "";
  let baseVersions: ReplicaIntentBaseVersion[];
  try {
    baseVersions = parseBaseVersions(body.baseVersions);
  } catch (error) {
    return sendJson(res, 400, {
      error: "invalid_replica_intent",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    !intentId ||
    !appId ||
    !action ||
    !("input" in body) ||
    !/^[a-f0-9]{64}$/u.test(payloadHash)
  ) {
    return sendJson(res, 400, {
      error: "invalid_replica_intent",
      message:
        "intentId, appId, action, input and a SHA-256 payloadHash are required",
    });
  }
  if (context.access.appId && context.access.appId !== appId) {
    return sendJson(res, 400, { error: "replica_app_scope_mismatch" });
  }
  let computed: string;
  try {
    computed = expectedPayloadHash(appId, action, body.input, baseVersions);
  } catch (error) {
    return sendJson(res, 400, {
      error: "invalid_replica_intent",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    !crypto.timingSafeEqual(Buffer.from(payloadHash), Buffer.from(computed))
  ) {
    return sendJson(res, 400, { error: "replica_intent_hash_mismatch" });
  }

  const identity = {
    deviceId: context.access.deviceId,
    appId,
    action,
    payloadHash,
  };
  const existing = readReplicaIntentOutcome(
    context.plane.db.vault,
    intentId,
    identity.deviceId
  );
  if (existing) {
    if (!sameIdentity(existing, identity)) {
      return concealIdentityConflict(res, intentId);
    }
    // Terminal and parked outcomes are immutable dedupe hits. A `sending`
    // row means the process died between durable admission and outcome;
    // re-enter dispatch with the same intent id, which the dispatcher binds
    // to deterministic vault invocation ids for replay-safe recovery.
    if (replicaOutcomeWire(existing)) return sendOutcome(res, existing);
  }

  // `canWrite` is the one predicate for "may this role mutate" — admin is
  // write's superset, so a hand-rolled `!== 'write'` here silently denied
  // every admin device, including the founding one.
  const deniedReason = canWrite(context.access.role)
    ? undefined
    : "read-only devices cannot submit actions";
  if (deniedReason) {
    try {
      const denied = recordReplicaIntentOutcome(context.plane.db.vault, {
        intentId,
        ...identity,
        status: "denied",
        reason: deniedReason,
      });
      return sendOutcome(res, denied);
    } catch {
      return concealIdentityConflict(res, intentId);
    }
  }

  // A precondition is checked against the canonical change sequence before
  // dispatch. The check is intentionally fail-closed for stale rows: the
  // device receives the current sequence it must refresh before retrying.
  // Once a canonical invocation marker exists, deterministic replay takes
  // precedence over a later unrelated edit.
  if (!hasCanonicalCommit(context.plane, intentId, "any")) {
    const conflict = currentConflict(
      context.plane,
      context.access,
      baseVersions
    );
    if (conflict) {
      try {
        const denied = recordReplicaIntentOutcome(context.plane.db.vault, {
          intentId,
          ...identity,
          status: "conflict",
          reason: "the edited row changed while this intent was offline",
          conflict,
        });
        return sendOutcome(res, denied);
      } catch {
        return concealIdentityConflict(res, intentId);
      }
    }
  }

  try {
    recordReplicaIntentOutcome(context.plane.db.vault, {
      intentId,
      ...identity,
      status: "sending",
    });
  } catch {
    // A wrong-device collision is intentionally indistinguishable from any
    // other immutable-id conflict.
    return concealIdentityConflict(res, intentId);
  }

  // A retained marker means this HTTP attempt is replaying a canonical
  // execution. Its arbitrary handler return was deliberately not persisted,
  // so only a dispatch with no pre-existing marker may surface live output.
  const canonicalCommitExistedBeforeDispatch = hasCanonicalCommit(
    context.plane,
    intentId,
    "any"
  );
  let dispatched: ReplicaIntentDispatchOutcome;
  try {
    dispatched = await runWithReplicaIntent(
      {
        intentId,
        appId,
        deviceId: identity.deviceId,
        // L4 attribution (#599): the acting member travels with the intent so
        // a replayed offline write names the person, not only the hardware.
        ...(context.access.memberId === undefined
          ? {}
          : { memberId: context.access.memberId }),
      },
      () =>
        context.dispatch({
          intentId,
          appId,
          action,
          input: body.input,
          ...(baseVersions.length > 0 ? { baseVersions } : {}),
        })
    );
  } catch {
    // Dispatch/transport failure is ambiguous: the canonical command may
    // already have committed and only its journal finalization or response
    // path failed. Keep `sending` so retry re-enters with the same intent id
    // and consumes the canonical commit marker instead of terminalizing a
    // possibly successful action as failed.
    const pending = readReplicaIntentOutcome(
      context.plane.db.vault,
      intentId,
      identity.deviceId
    );
    if (!pending) {
      return sendJson(res, 500, { error: "replica_intent_admission_lost" });
    }
    return sendOutcome(res, pending);
  }
  // The worker-facing bridge necessarily reports a post-canonical journal
  // failure as VAULT_ERROR. Blueprints may catch ctx.vault.invoke errors and
  // return a successful `{status: 'denied'}` action envelope, so an unfinished
  // marker makes that terminal result ambiguous. Keep admission retryable
  // until deterministic replay repairs the journal. A fully finalized marker,
  // however, proves only that one invocation committed; it must not overwrite
  // a genuine denial/failure returned by a later invocation in the same action.
  const canonicalFinalizationPending = hasCanonicalCommit(
    context.plane,
    intentId,
    "pending"
  );
  if (dispatched.status === "retryable" || canonicalFinalizationPending) {
    const pending = readReplicaIntentOutcome(
      context.plane.db.vault,
      intentId,
      identity.deviceId
    );
    if (!pending) {
      return sendJson(res, 500, { error: "replica_intent_admission_lost" });
    }
    return sendOutcome(res, pending);
  }
  let outcome: ReplicaIntentOutcome;
  try {
    outcome = recordReplicaIntentOutcome(context.plane.db.vault, {
      intentId,
      ...identity,
      status: dispatched.status,
      ...(dispatched.status === "parked" && dispatched.invocationId
        ? { invocationId: dispatched.invocationId }
        : {}),
      ...("reason" in dispatched && dispatched.reason
        ? { reason: dispatched.reason }
        : {}),
      // Handler returns are live process data. Never copy an arbitrary value
      // into the durable device outcome; canonical row changes reconcile it.
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: "replica_intent_outcome_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return sendOutcome(
    res,
    outcome,
    dispatched.status === "executed" && !canonicalCommitExistedBeforeDispatch
      ? dispatched.output
      : NO_TRANSIENT_OUTPUT
  );
}
