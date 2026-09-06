import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  expiredOutcomeRecovery,
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
  replicaDependencyVerdict,
  resolvePredecessorReferences,
} from "@centraid/vault";
import type { ReplicaIntentOutcome } from "@centraid/vault";

import { runWithReplicaIntent } from "../serve/replica-intent-context.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import {
  currentConflict,
  expectedPayloadHash,
  missingReadSetVersions,
  hasCanonicalCommit,
  parseBaseVersions,
  parseDependsOn,
} from "./replica-intent-shape.js";
import type { ReplicaIntentBaseVersion } from "./replica-intent-shape.js";
import { replicaOutcomeWire } from "./replica-projection.js";
import { REPLICA_PROTOCOL_VERSION } from "./replica-shape.js";
import type { ReplicaShapeAccess } from "./replica-shape.js";
import { readJson, sendJson } from "./route-helpers.js";

export type { ReplicaIntentBaseVersion } from "./replica-intent-shape.js";

export interface ReplicaIntentDispatchInput {
  intentId: string;
  appId: string;
  action: string;
  input: unknown;
  baseVersions?: ReplicaIntentBaseVersion[];
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
  access: ReplicaShapeAccess & { deviceId: string; ownerId?: string };
  dispatch: ReplicaIntentDispatcher;
}

const NO_TRANSIENT_OUTPUT = Symbol("no transient replica output");

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
  // UUID collisions aren't actionable: ordinary in-flight ack, no existence oracle.
  return sendJson(res, 202, {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    accepted: true,
    outcome: { intentId, status: "in-flight" },
  });
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
  let dependsOn: string[];
  try {
    baseVersions = parseBaseVersions(body.baseVersions);
    dependsOn = parseDependsOn(body.dependsOn);
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
  // THE DECLARED READ-SET IS PART OF THE ADMISSION (#996, rulings R6/R21/R23).
  // An intent that names the domain operation it runs must reference every row
  // that operation reads to decide; a set short of it would settle against a
  // version nobody observed, which is the conflict check answering a question
  // it was never asked.
  const operation =
    typeof body.operation === "string" && body.operation.length > 0
      ? body.operation
      : undefined;
  const readSetGaps = missingReadSetVersions(
    operation,
    body.input,
    baseVersions
  );
  if (readSetGaps.length > 0) {
    return sendJson(res, 400, {
      error: "replica_intent_read_set_incomplete",
      message: `${operation} reads rows this intent did not reference`,
      missing: readSetGaps,
    });
  }
  let computed: string;
  try {
    computed = expectedPayloadHash(
      appId,
      action,
      body.input,
      baseVersions,
      dependsOn
    );
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
      // SAME ID, DIFFERENT PAYLOAD (#996, R24). This is the DEVICE'S OWN
      // intent — `readReplicaIntentOutcome` is device-scoped, so another
      // device's id never reaches here and is still concealed below — and
      // telling it plainly is the only safe answer: the retained outcome
      // answers the payload it was recorded for, and answering a different
      // one with it would settle a change that never ran. There is no
      // existence to leak: the device is asking about its own intent.
      return sendJson(res, 409, {
        error: "replica_intent_payload_mismatch",
        message:
          "this intent id was admitted with a different payload; mint a new id for a changed operation",
        intentId,
      });
    }
    // THE WINDOW HAS A FAR EDGE, AND "I NO LONGER KNOW" IS THE ANSWER AT IT
    // (#996, R24, OQ-13). The retained outcome is what makes a retry
    // idempotent; once it has aged out, re-executing could duplicate an
    // effect the member already has. The seat is told to mint a NEW id
    // against a freshly observed base — the same move a conflict asks for,
    // for the same reason — and never quietly re-run.
    const expired = expiredOutcomeRecovery(context.plane.db.vault, intentId);
    if (expired) {
      return sendJson(res, 409, {
        error: "replica_intent_outcome_expired",
        ...expired,
      });
    }
    // A CHAIN PARK IS A WAIT, NOT A VERDICT (#996, R23). Every other parked
    // outcome is an immutable dedupe hit — it is waiting on a PERSON, and
    // resending it changes nothing. A dependency park is waiting on another
    // INTENT, and the whole point is that it releases when that intent lands:
    // if this one were terminal too, the queue behind a slow predecessor
    // would never drain and the member would have to re-queue by hand.
    const chainPark =
      existing.status === "parked" && existing.waitingOn?.seat === "intent";
    // Terminal/parked outcomes are immutable dedupe hits; a `sending` row
    // died pre-outcome — re-enter dispatch.
    if (!chainPark && replicaOutcomeWire(existing))
      return sendOutcome(res, existing);
  }

  // access.canWrite is THE may-mutate predicate (#726): deny read-only
  // commons scopes here, not deeper in the plane.
  const deniedReason = context.access.canWrite
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

  // AN OFFLINE CHAIN IS CAUSAL (#996, R23/R25), and the gateway is where that
  // is enforced. A rename cannot execute before the create it renames; only
  // the gateway sees the whole chain, and only the gateway can answer the
  // question atomically with executing it. Before the conflict check on
  // purpose: a dependent's base versions describe rows its predecessor has
  // not produced yet, so checking them first would report a conflict where
  // the honest answer is "not yet".
  if (dependsOn.length > 0) {
    const verdict = replicaDependencyVerdict(context.plane.db.vault, dependsOn);
    if (verdict.kind !== "ready") {
      // WAITING AND ABANDONED ARE DIFFERENT FACTS and lead to different
      // screens: one releases on its own when the predecessor lands, the
      // other never will, and naming the predecessor is what makes a stuck
      // queue readable instead of silent. Both PARK — the intent is retained,
      // not lost, so a retry of the predecessor releases it.
      try {
        const parked = recordReplicaIntentOutcome(context.plane.db.vault, {
          intentId,
          ...identity,
          status: "parked",
          reason: verdict.reason,
          waitingOn: { seat: "intent", label: verdict.on },
          dependsOn,
        });
        return sendOutcome(res, parked);
      } catch {
        return concealIdentityConflict(res, intentId);
      }
    }
  }

  // Precondition vs canonical sequence, fail-closed for stale rows; once a
  // canonical marker exists, replay beats a later unrelated edit.
  if (!hasCanonicalCommit(context.plane.db.vault, intentId, "any")) {
    const conflict = currentConflict(
      context.plane.db.vault,
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
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    });
  } catch {
    // Intentionally indistinguishable from any other immutable-id conflict.
    return concealIdentityConflict(res, intentId);
  }

  const resolvedInput =
    dependsOn.length > 0
      ? resolvePredecessorReferences(context.plane.db.vault, body.input)
      : body.input;

  // A retained marker = replay of a canonical execution; only fresh dispatch
  // may surface live output.
  const canonicalCommitExistedBeforeDispatch = hasCanonicalCommit(
    context.plane.db.vault,
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
        // L4 attribution (#599): the acting owner travels with the intent.
        ...(context.access.ownerId === undefined
          ? {}
          : { ownerId: context.access.ownerId }),
      },
      () =>
        context.dispatch({
          intentId,
          appId,
          action,
          // THE CHAIN NAMES ROWS THAT DID NOT EXIST WHEN IT WAS WRITTEN. The
          // create that mints the task has not run when the rename is queued,
          // so the rename carries `{"$intent": "<id>"}` and the gateway
          // substitutes the row that intent actually PRODUCED — plain
          // equality against the outcome table, never "the latest task".
          // After the hash check on purpose: the hash covers what the seat
          // sent, which is what a retry will send again.
          input: resolvedInput,
          ...(baseVersions.length > 0 ? { baseVersions } : {}),
        })
    );
  } catch {
    // Dispatch failure is ambiguous (the command may have committed): keep
    // `sending` so retry consumes the marker.
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
  // Post-canonical journal failures surface as VAULT_ERROR and blueprints may
  // catch invoke errors into denials, so terminal results are ambiguous while
  // the marker is unfinished — stay retryable until replay repairs it. A
  // finalized marker proves one commit; it never overwrites a genuine denial.
  const canonicalFinalizationPending = hasCanonicalCommit(
    context.plane.db.vault,
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
      // Handler returns are live process data — never copied into durable
      // outcomes; canonical row changes reconcile it.
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
