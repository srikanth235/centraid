// PER-INTENT STEWARD DECISION (#872) — the steward's answer to ONE durable
// member request, beside the member's own `cancelCommonsIntent`.
//
// APPROVING IS NOT A SECOND WRITE PATH. It re-enters `executeCommonsCommand`,
// exactly as the peer sweep does, so the signature, the stale-context
// judgement, the ordered op and the fan-out are the SAME machinery a live
// member command goes through. There is no "approved, therefore skip
// authorization" door.
//
// A durable intent lives in the ACTOR's own seat, never mirrored to the
// steward, so deciding one means reaching that seat through the host's
// mounted-vault resolver.
//
// DECLINE APPENDS NO OPERATION: a refusal is a policy answer, never a rail
// refusal, so advancing the grant's sequence for it would put a command in the
// ordered log that nothing executed. #750 carries it as `denied` with a reason.

import type { DatabaseSync } from "node:sqlite";

import type { VaultDb } from "../db.js";
import { writeReceipt } from "../gateway/evidence.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { commonsSeats } from "./commons-lifecycle.js";
import { signCommonsIntent } from "./commons-signature.js";
import {
  executeCommonsCommand,
  readCommonsGrant,
  settleCommonsIntent,
} from "./commons.js";
import type { CommonsIntentStatus } from "./commons.js";

const DECIDE_PURPOSE = "dpv:ServiceProvision";

/**
 * `cancelled` is deliberately inside the window: `cancelCommonsIntent`'s status
 * guard is the MEMBER's, and the steward's settle is unconditional — the owner
 * of the commons gets the last word. `executed` and `denied` are already
 * answered and `expired` timed out, so re-answering would narrate something
 * that did not happen.
 */
const DECIDABLE: ReadonlySet<CommonsIntentStatus> = new Set([
  "queued",
  "parked",
  "cancelled",
]);

interface SeatIntent {
  seat: VaultDb;
  seatVaultId: string;
  intentId: string;
  grantId: string;
  actorPartyId: string;
  command: string;
  commandInput: Record<string, unknown>;
  basedOnSequence: number;
  status: CommonsIntentStatus;
}

interface IntentRow {
  grant_id: string;
  actor_party_id: string;
  command: string;
  input_json: string;
  based_on_sequence: number;
  status: CommonsIntentStatus;
}

function readIntentRow(
  seat: DatabaseSync,
  intentId: string
): IntentRow | undefined {
  return seat
    .prepare(
      `SELECT grant_id, actor_party_id, command, input_json,
              based_on_sequence, status
         FROM share_commons_intent WHERE intent_id = ?`
    )
    .get(intentId) as IntentRow | undefined;
}

/** A malformed historical payload is not an input a command may run on. */
function commandInputOf(
  row: IntentRow,
  intentId: string
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(row.input_json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`commons intent ${intentId} has no command input to run`);
  return parsed as Record<string, unknown>;
}

/** Candidates come off the steward's OWN control rows, so a vault this commons
 *  never admitted is never opened. */
export function commonsIntentSeatCandidates(input: {
  steward: DatabaseSync;
  stewardVaultId: string;
}): string[] {
  const bound = input.steward
    .prepare(
      `SELECT DISTINCT b.vault_id AS vaultId
         FROM share_commons_member_state s
         JOIN share_party_vault_binding b
           ON b.party_id = s.party_id AND b.revoked_at IS NULL
         JOIN share_circle_grant g ON g.grant_id = s.grant_id
        WHERE g.plane = 'commons' AND g.revoked_at IS NULL
        ORDER BY b.vault_id`
    )
    .all() as { vaultId: string }[];
  const seen = new Set<string>([input.stewardVaultId]);
  const candidates = [input.stewardVaultId];
  for (const row of bound) {
    if (seen.has(row.vaultId)) continue;
    seen.add(row.vaultId);
    candidates.push(row.vaultId);
  }
  return candidates;
}

export function findCommonsIntentSeat(input: {
  steward: VaultDb;
  stewardVaultId: string;
  intentId: string;
  vaultFor: (vaultId: string) => VaultDb | undefined;
}): SeatIntent | undefined {
  for (const vaultId of commonsIntentSeatCandidates({
    steward: input.steward.vault,
    stewardVaultId: input.stewardVaultId,
  })) {
    const seat =
      vaultId === input.stewardVaultId
        ? input.steward
        : input.vaultFor(vaultId);
    if (!seat) continue;
    const row = readIntentRow(seat.vault, input.intentId);
    if (!row) continue;
    return {
      seat,
      seatVaultId: vaultId,
      intentId: input.intentId,
      grantId: row.grant_id,
      actorPartyId: row.actor_party_id,
      command: row.command,
      commandInput: commandInputOf(row, input.intentId),
      basedOnSequence: row.based_on_sequence,
      status: row.status,
    };
  }
  return undefined;
}

/** The SAME resolution `Gateway.invoke` performs before it calls a write
 *  steward-side: live binding, party on the grant's circle, member state
 *  `current`. Falls back to the vault's own owner party. */
export function commonsPartyForVault(input: {
  steward: DatabaseSync;
  grantId: string;
  circleId: string;
  vaultId: string;
}): string | undefined {
  const bound = input.steward
    .prepare(
      `SELECT b.party_id AS partyId FROM share_party_vault_binding b
         JOIN social_circle_member m ON m.party_id = b.party_id
         JOIN share_commons_member_state s
           ON s.grant_id = ? AND s.party_id = b.party_id AND s.status = 'current'
        WHERE b.vault_id = ? AND b.revoked_at IS NULL
          AND m.circle_id = ? LIMIT 1`
    )
    .get(input.grantId, input.vaultId, input.circleId) as
    | { partyId: string }
    | undefined;
  if (bound) return bound.partyId;
  const local = input.steward
    .prepare("SELECT self_party_id AS ownerPartyId FROM core_vault LIMIT 1")
    .get() as { ownerPartyId: string | null } | undefined;
  return local?.ownerPartyId ?? undefined;
}

export interface DecideCommonsIntentInput {
  /** The DECIDING seat. Must hold the grant as its steward — checked, never assumed. */
  steward: VaultDb;
  stewardVaultId: string;
  gateway: Gateway;
  credential: Credential;
  intentId: string;
  decision: "approve" | "decline";
  reason?: string;
  vaultFor: (vaultId: string) => VaultDb | undefined;
  invokeFor?: (
    vaultId: string,
    command: string,
    commandInput: Record<string, unknown>,
    invocationId: string
  ) => InvokeOutcome;
  now: string;
}

export interface CommonsIntentDecisionResult {
  intentId: string;
  grantId: string;
  decision: "approve" | "decline";
  /** Read back off the seat AFTER the decision — never the status we assumed. */
  status: CommonsIntentStatus;
  decided: boolean;
  reason?: string;
  sequence?: number;
  receiptId: string;
}

const DEFAULT_DECLINE_REASON =
  "the steward declined this request; nothing was applied";

/** One sentence for both ways a caller can fail to be the steward. */
const NOT_THE_STEWARD =
  "only the commons steward can approve or decline a member request";

/**
 * Throws — the route answers `400` — for the three things that are not
 * decisions: an intent no mounted seat holds, a caller who is not this grant's
 * steward, and a member deciding their own request (that verb is
 * `cancelCommonsIntent`; calling it "decline" would let a member refuse
 * themselves in the steward's name). A late decision is not an error — it
 * answers `decided: false` with the status that stands.
 */
export function decideCommonsIntent(
  input: DecideCommonsIntentInput
): CommonsIntentDecisionResult {
  const found = findCommonsIntentSeat({
    steward: input.steward,
    stewardVaultId: input.stewardVaultId,
    intentId: input.intentId,
    vaultFor: input.vaultFor,
  });
  if (!found)
    throw new Error(`commons intent ${input.intentId} is not available`);
  // A seat that does not hold the grant cannot be its steward, and
  // `readCommonsGrant` would fail with a row-level "not available" that reads
  // like a missing intent.
  const held = input.steward.vault
    .prepare(
      `SELECT 1 AS n FROM share_circle_grant
        WHERE grant_id = ? AND plane = 'commons' AND revoked_at IS NULL`
    )
    .get(found.grantId);
  if (!held) throw new Error(NOT_THE_STEWARD);
  const grant = readCommonsGrant(input.steward.vault, found.grantId);
  const deciderPartyId = commonsPartyForVault({
    steward: input.steward.vault,
    grantId: grant.grantId,
    circleId: grant.circleId,
    vaultId: input.stewardVaultId,
  });
  if (!deciderPartyId || deciderPartyId !== grant.stewardPartyId)
    throw new Error(NOT_THE_STEWARD);
  if (found.actorPartyId === deciderPartyId)
    throw new Error(
      "a member withdraws their own request by cancelling it, not by declining it"
    );

  const record = (
    outcome: Omit<CommonsIntentDecisionResult, "receiptId" | "status">
  ): CommonsIntentDecisionResult => {
    const status =
      readIntentRow(found.seat.vault, input.intentId)?.status ?? found.status;
    const receiptId = writeReceipt(input.steward.audit, {
      grantId: grant.grantId,
      // NOT the intent id: `invocation_id` is a foreign key into
      // `agent_command_invocation`, and a decision is not an invocation.
      invocationId: null,
      action: `decide ${found.command}`,
      objectType: "share.commons",
      objectId: grant.grantId,
      purpose: DECIDE_PURPOSE,
      decision:
        input.decision === "approve" && outcome.decided && !outcome.reason
          ? "allow"
          : "deny",
      detail: {
        intentId: input.intentId,
        decision: input.decision,
        actorPartyId: deciderPartyId,
        intentActorPartyId: found.actorPartyId,
        applied: outcome.decided,
        status,
        ...(outcome.reason ? { failing: outcome.reason } : {}),
      },
    });
    return { ...outcome, status, receiptId };
  };

  if (!DECIDABLE.has(found.status))
    return record({
      intentId: input.intentId,
      grantId: grant.grantId,
      decision: input.decision,
      decided: false,
      reason: `this request was already ${found.status}`,
    });

  if (input.decision === "decline") {
    const reason = input.reason?.trim() || DEFAULT_DECLINE_REASON;
    settleCommonsIntent({
      seat: found.seat.vault,
      intentId: input.intentId,
      status: "denied",
      reason,
      now: input.now,
    });
    return record({
      intentId: input.intentId,
      grantId: grant.grantId,
      decision: "decline",
      decided: true,
      reason,
    });
  }

  const seats = commonsSeats({
    steward: input.steward.vault,
    grantId: grant.grantId,
    stewardVaultId: input.stewardVaultId,
    vaultFor: input.vaultFor,
    ...(input.invokeFor ? { invokeFor: input.invokeFor } : {}),
  });
  // The member's OWN vault signs, exactly as on the live rail: the steward
  // approving does not make the steward the author, and `commandRefuses`
  // verifies against the pinned binding either way. A steward-authored intent
  // needs none.
  const memberSignature =
    found.actorPartyId === grant.stewardPartyId
      ? undefined
      : signCommonsIntent(found.seat.identitySeed, {
          grantId: grant.grantId,
          actorPartyId: found.actorPartyId,
          command: found.command,
          commandInput: found.commandInput,
          memberVaultId: found.seatVaultId,
          nonce: input.intentId,
        });
  const result = executeCommonsCommand({
    steward: input.steward,
    gateway: input.gateway,
    credential: input.credential,
    stewardVaultId: input.stewardVaultId,
    grantId: grant.grantId,
    actorPartyId: found.actorPartyId,
    command: found.command,
    commandInput: found.commandInput,
    seats,
    ...(memberSignature ? { memberSignature } : {}),
    basedOnSequence: found.basedOnSequence,
    intentId: input.intentId,
    invocationId: input.intentId,
    now: input.now,
  });
  // A rail refusal is the steward's answer too: settle it here, because
  // `executeCommonsCommand` only fans `executed` out to seats.
  if (!result.decision.accepted)
    settleCommonsIntent({
      seat: found.seat.vault,
      intentId: input.intentId,
      status: "denied",
      ...(result.decision.reason ? { reason: result.decision.reason } : {}),
      now: input.now,
    });
  return record({
    intentId: input.intentId,
    grantId: grant.grantId,
    decision: "approve",
    decided: true,
    ...(result.decision.reason ? { reason: result.decision.reason } : {}),
    sequence: result.decision.sequence,
  });
}
