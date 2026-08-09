/*
 * The ORIGIN half of a write-capable live edge (#726 P5). The audience's
 * queued intent lands here and runs through `Gateway.invokeAsIdentity` —
 * the SAME consent chain, Tier-3/4 parking, hash-chained receipts, and
 * journal as any local action. That is the whole point of executing it at
 * the origin instead of replicating a write: there is exactly one way
 * anything gets written here, and a read-only edge's attempt is refused BY
 * THAT SAME CHAIN (`identity.mayAct: false`), not by a route-level guess
 * standing in for it.
 *
 * Dedupe/conflict bookkeeping reuses vault.db's `replica_intent_outcome`
 * UNCHANGED — its `device_id`/`app_id` columns carry no foreign key, so a
 * lend edge's own id fits the SAME table a device's own offline intent
 * already uses. "The shape does not change" is literal: no new column, no
 * new table, on this side.
 *
 * Both identity columns collapse to `edgeId` here (never the origin's
 * internal grantee party id): a device path has TWO independent axes
 * (device, app) because one device runs many apps, but one live edge has
 * exactly one caller, and — unlike an app's own id — the party id is an
 * ORIGIN-side implementation detail the audience never learns. Hashing
 * against it would make `payloadHash` unverifiable by the very caller who
 * is supposed to prove they sent an unmodified payload.
 */

import crypto from "node:crypto";

import {
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
} from "@centraid/vault";
import type {
  Gateway as VaultGateway,
  Identity,
  InvokeOutcome,
  ShareVaultRef,
} from "@centraid/vault";

import {
  currentConflict,
  expectedPayloadHash,
  hasCanonicalCommit,
  parseBaseVersions,
} from "../routes/replica-intent-shape.js";
import type {
  ReplicaIntentBaseVersion,
  ReplicaIntentConflict,
} from "../routes/replica-intent-shape.js";
import { ensureLendActor } from "./lend-grant.js";
import type { LentEdgeRow } from "./lend-origin.js";

export interface LendIntentRequest {
  intentId: string;
  action: string;
  input: unknown;
  payloadHash: string;
  baseVersions?: unknown;
}

export type LendIntentFrame =
  | { state: "executed"; invocationId: string; output: unknown }
  | { state: "parked"; invocationId: string; reason: string }
  | { state: "denied"; reason: string }
  | { state: "failed"; invocationId: string; reason: string }
  | { state: "conflict"; conflict: ReplicaIntentConflict }
  | { state: "in_flight" }
  | { state: "bad_request"; detail: string };

/** Map a LIVE invoke outcome — the first, synchronous attempt, still
 *  carrying the handler's real output. */
function frameForLive(outcome: InvokeOutcome): LendIntentFrame {
  switch (outcome.status) {
    case "executed":
      return {
        state: "executed",
        invocationId: outcome.invocationId,
        output: outcome.output,
      };
    case "replayed":
      return {
        state: "executed",
        invocationId: outcome.invocationId,
        output: outcome.output,
      };
    case "parked":
      return {
        state: "parked",
        invocationId: outcome.invocationId,
        reason: outcome.reason,
      };
    case "denied":
      return { state: "denied", reason: outcome.reason };
    case "failed":
      return {
        state: "failed",
        invocationId: outcome.invocationId,
        reason: outcome.reason,
      };
    default:
      return { state: "in_flight" };
  }
}

/** Map a DURABLE row — a resend hitting an already-terminal/parked record,
 *  never re-invoked. */
function frameForRecorded(
  status: string,
  reason: string | undefined,
  invocationId: string | undefined,
  conflict: ReplicaIntentConflict | undefined
): LendIntentFrame {
  switch (status) {
    case "executed":
      return {
        state: "executed",
        invocationId: invocationId ?? "",
        output: undefined,
      };
    case "parked":
      return {
        state: "parked",
        invocationId: invocationId ?? "",
        reason: reason ?? "requires owner confirmation",
      };
    case "denied":
      return { state: "denied", reason: reason ?? "denied" };
    case "failed":
      return {
        state: "failed",
        invocationId: invocationId ?? "",
        reason: reason ?? "failed",
      };
    case "conflict":
      return { state: "conflict", conflict: conflict! };
    default:
      return { state: "in_flight" };
  }
}

/**
 * Run one audience-queued intent against the origin. `row.verbs` decides
 * `mayAct` on the identity, not whether this function is even entered — a
 * read-only edge's attempted write is refused by the ORDINARY consent chain
 * (`evaluateConsent`'s readonly-device branch), so the refusal is receipted
 * and journaled exactly like any other denial, never a special case here.
 */
export function executeLentIntent(
  origin: ShareVaultRef,
  gateway: VaultGateway,
  row: LentEdgeRow,
  request: LendIntentRequest
): LendIntentFrame {
  if (
    !request.intentId ||
    !request.action ||
    request.input === undefined ||
    !/^[a-f0-9]{64}$/u.test(request.payloadHash)
  ) {
    return {
      state: "bad_request",
      detail: "intentId, action, input and a SHA-256 payloadHash are required",
    };
  }
  const appId = row.edge_id;
  let baseVersions: ReplicaIntentBaseVersion[];
  try {
    baseVersions = parseBaseVersions(request.baseVersions);
  } catch (error) {
    return {
      state: "bad_request",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let computed: string;
  try {
    computed = expectedPayloadHash(
      appId,
      request.action,
      request.input,
      baseVersions
    );
  } catch (error) {
    return {
      state: "bad_request",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (
    !crypto.timingSafeEqual(
      Buffer.from(request.payloadHash),
      Buffer.from(computed)
    )
  ) {
    return { state: "bad_request", detail: "payload hash mismatch" };
  }

  const identityFields = {
    deviceId: row.edge_id,
    appId,
    action: request.action,
    payloadHash: request.payloadHash,
  };
  const existing = readReplicaIntentOutcome(
    origin.vault,
    request.intentId,
    row.edge_id
  );
  if (existing) {
    if (
      existing.appId !== appId ||
      existing.action !== request.action ||
      existing.payloadHash !== request.payloadHash
    ) {
      return {
        state: "bad_request",
        detail: "intent id reused with different content",
      };
    }
    // Terminal or parked: a resend (retry after offline, or a status poll —
    // one frame answers both, #726 P5) returns the durable outcome as-is,
    // never a second invocation.
    if (existing.status !== "sending" && existing.status !== "queued") {
      return frameForRecorded(
        existing.status,
        existing.reason,
        existing.invocationId,
        existing.conflict as ReplicaIntentConflict | undefined
      );
    }
  }

  const access = {
    canWrite: row.verbs === "read+act",
    rememberDevice: false,
    grantee: { partyId: row.grantee_party_id, keySecret: row.row_key_secret },
  };
  if (!hasCanonicalCommit(origin.vault, request.intentId, "any")) {
    const conflict = currentConflict(origin.vault, access, baseVersions);
    if (conflict) {
      const denied = recordReplicaIntentOutcome(origin.vault, {
        intentId: request.intentId,
        ...identityFields,
        status: "conflict",
        reason: "the edited row changed while this intent was offline",
        conflict,
      });
      return frameForRecorded(
        denied.status,
        denied.reason,
        denied.invocationId,
        denied.conflict as ReplicaIntentConflict | undefined
      );
    }
  }

  recordReplicaIntentOutcome(origin.vault, {
    intentId: request.intentId,
    ...identityFields,
    status: "sending",
  });

  const agentId = ensureLendActor(origin.vault, row.grantee_party_id);
  const identity: Identity = {
    kind: "agent",
    callerId: agentId,
    provAgentKind: "ai_agent",
    partyId: row.grantee_party_id,
    // The origin's own consent chain is the one answerer for "may this edge
    // act" — a read-only edge denies HERE, structurally, exactly as a
    // readonly device would (#726 P5, mirrors replica-shape.ts's grantee
    // mayAct wiring for the read plane).
    mayAct: row.verbs === "read+act",
  };
  let outcome: InvokeOutcome;
  try {
    outcome = gateway.invokeAsIdentity(identity, {
      command: request.action,
      input: request.input as Record<string, unknown>,
      intentId: request.intentId,
      invocationId: crypto.randomUUID(),
    });
  } catch {
    // Ambiguous failure: the command may already have committed and only
    // the response path failed. Leave the row at 'sending' — the same
    // resend the audience would send anyway replays deterministically.
    return { state: "in_flight" };
  }
  recordReplicaIntentOutcome(origin.vault, {
    intentId: request.intentId,
    ...identityFields,
    status: outcome.status === "replayed" ? "executed" : outcome.status,
    ...("invocationId" in outcome && outcome.invocationId
      ? { invocationId: outcome.invocationId }
      : {}),
    ...("reason" in outcome && outcome.reason
      ? { reason: outcome.reason }
      : {}),
  });
  return frameForLive(outcome);
}
