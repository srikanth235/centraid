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

function commandInputOf(
  row: IntentRow,
  intentId: string
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(row.input_json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`commons intent ${intentId} has no command input to run`);
  return parsed as Record<string, unknown>;
}

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
  status: CommonsIntentStatus;
  decided: boolean;
  reason?: string;
  sequence?: number;
  receiptId: string;
}

const DEFAULT_DECLINE_REASON =
  "the steward declined this request; nothing was applied";

const NOT_THE_STEWARD =
  "only the commons steward can approve or decline a member request";

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
