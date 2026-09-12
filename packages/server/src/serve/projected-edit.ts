/*
 * A PROJECTED ROW'S EDIT GOES HOME (#996, R10).
 *
 * A row this vault holds through a subscription is the ORIGIN's. The audience
 * is not its writer: it holds no grant over it, the origin is the single
 * writer of its own rows (#929 wave 3), and anything written here would be
 * erased by the next pass's `update` — silently, which is the failure this
 * module exists to prevent.
 *
 * So an edit intent whose read-set names a projected row is not executed
 * locally. `forwardProjectedEdit` answers WHERE the row came from, this module
 * carries the intent there as the member intent the origin's door already
 * knows (`routes/peer-replica-intent-route.ts`), and the answer the seat gets
 * is the ORIGIN'S — its status, its reason, its `commit_seq`. The seat's
 * pending overlay clears when the share output carrying that commit lands,
 * which is why the number has to be the origin's rather than a local one.
 *
 * ADDRESS DATA ONLY LIVES ABOVE. Which link reaches which vault is the host's
 * fact (`build-gateway.ts`); this module is handed a dial and a route.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { shareShapeId } from "@centraid/core/protocol";
import {
  forwardProjectedEdit,
  MEMBER_INTENT_WINDOW_MS,
  memberIntentBytes,
} from "@centraid/vault";
import type { MemberIntentEnvelope, ProjectedEditRoute } from "@centraid/vault";

import { PEER_REPLICA_INTENTS_PATH } from "../routes/peer-replica-route.js";
import type { ReplicaIntentBaseVersion } from "../routes/replica-intent-shape.js";
import type { PeerDial, PeerDialRoute } from "./peer-link-client.js";

/**
 * What the origin answered. `retryable` is a fact about REACH, never about the
 * intent: the seat's row stays `sending` and the next retry asks again.
 */
export interface ProjectedEditAnswer {
  status: "executed" | "denied" | "parked" | "retryable" | "conflict";
  reason?: string;
  /** The ORIGIN's canonical commit; the seat waits for it, not for a local one. */
  commitSeq?: number;
  /**
   * WHICH ROW MOVED, AND TO WHAT (#1014, V7). The origin now checks a member's
   * base versions, so a refusal can be a CONFLICT rather than a denial — and a
   * conflict the seat cannot name is one the member cannot act on. Carried
   * through verbatim so the outbox row reads the same as a device conflict's.
   */
  conflict?: {
    shapeId?: string;
    entity: string;
    rowId: string;
    expectedVersion: number;
    actualVersion: number;
  };
}

export interface ProjectedEditRequest {
  route: ProjectedEditRoute;
  /** The vault the edit was composed IN — the member's, and the one that signs. */
  audienceVaultId: string;
  intentId: string;
  appId: string;
  action: string;
  input: unknown;
  baseVersions: readonly ReplicaIntentBaseVersion[];
}

export type ProjectedEditForwarder = (
  request: ProjectedEditRequest
) => Promise<ProjectedEditAnswer>;

/**
 * The projected row this intent edits, or `undefined` when every row it names
 * is this vault's own.
 *
 * THE DECLARED READ-SET IS THE QUESTION (R6/R21/R23). An intent must reference
 * every row its operation reads to decide, so the base versions are the rows
 * the write is ABOUT — asking them is asking the intent, rather than guessing
 * from a command's input shape. The FIRST projected row wins: an intent
 * spanning two vaults has no single writer and the origin it names refuses the
 * half that is not its own, which is the honest answer rather than a local
 * write of the other half.
 */
export function projectedEditTarget(
  vault: DatabaseSync,
  baseVersions: readonly ReplicaIntentBaseVersion[]
): ProjectedEditRoute | undefined {
  for (const base of baseVersions) {
    const route = forwardProjectedEdit(vault, {
      entity: base.entity,
      rowId: base.rowId,
    });
    if (route) return route;
  }
  return undefined;
}

export interface ForwardOverPeerInput {
  dial: PeerDial;
  /** Where the ORIGIN gateway is. Address data, never identity. */
  peerRoute: PeerDialRoute;
  /** `VaultRegistry.signAsVault` — the MEMBER's vault key signs, not the link's. */
  signAsVault: (vaultId: string, bytes: Buffer) => Buffer | undefined;
}

/**
 * Carry one forwarded edit to the origin over the peer transport.
 *
 * The row ids the envelope names are the ORIGIN'S, translated out of lineage:
 * the audience's copy may be under a different id entirely (a deduped
 * photograph, a colliding uuid), and an intent naming the audience's id would
 * address a row the origin does not have.
 */
export async function forwardOverPeer(
  input: ForwardOverPeerInput,
  request: ProjectedEditRequest
): Promise<ProjectedEditAnswer> {
  const envelope: MemberIntentEnvelope = {
    intentId: request.intentId,
    shapeId: shareShapeId(request.route.authorityId),
    originVaultId: request.route.originVaultId,
    memberVaultId: request.audienceVaultId,
    appId: request.appId,
    action: request.action,
    input: request.input,
    // THE REPLAY WINDOW IS STATED BY THE SENDER (#1014, V7), inside the signed
    // bytes, so a captured envelope stops being presentable. The nonce makes
    // two otherwise-identical sends distinguishable byte for byte, which is
    // what stops a captured signature standing in for a later one.
    expiresAt: new Date(Date.now() + MEMBER_INTENT_WINDOW_MS).toISOString(),
    nonce: randomUUID(),
    // NO BASE VERSION FROM LINEAGE (#1014, V7). `origin_row_version` is
    // documented as, and written as, the ORIGIN'S REPLICA CHANGE SEQUENCE —
    // `applyShareOutputs` stores `outputs.cursor.seq` and `projectShareClosure`
    // stores `grant.rowVersions` (a log position, `?? 0`). Sending it as a base
    // version would compare a transport position against `row_version` in
    // `originConflict`: 432 against 2, refusing every member edit. It was never
    // read before this slice, so stating nothing is what it always meant.
    //
    // WHAT ARMS THIS: the lineage carrying the origin's own `row_version` for
    // the row. The number is already in the share row image and is stripped as
    // a LOCAL column by `apply-outputs.ts#LOCAL_COLUMNS`; carrying it needs a
    // lineage column of its own (`origin_row_version` cannot be repurposed —
    // `subscription-seat.ts` compares the pending-drop against it as a log
    // position). Until then the origin's door checks whatever base versions an
    // envelope DOES state, and a member's forwarded edit states none.
  };
  const signature = input.signAsVault(
    request.audienceVaultId,
    memberIntentBytes(envelope)
  );
  if (!signature)
    return {
      status: "retryable",
      reason: `this vault cannot sign for ${request.audienceVaultId}`,
    };
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        input.peerRoute.endpointId,
        input.peerRoute.relayHints
      ),
      method: "POST",
      target: PEER_REPLICA_INTENTS_PATH,
      body: { ...envelope, signature: signature.toString("base64") },
    });
  } catch (error) {
    return {
      status: "retryable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return answerOf(response);
}

function isConflictWire(
  value: unknown
): value is NonNullable<ProjectedEditAnswer["conflict"]> {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.entity === "string" &&
    typeof row.rowId === "string" &&
    Number.isSafeInteger(row.expectedVersion) &&
    Number.isSafeInteger(row.actualVersion)
  );
}

function answerOf(response: {
  status: number;
  json: unknown;
}): ProjectedEditAnswer {
  const body =
    response.json !== null && typeof response.json === "object"
      ? (response.json as {
          state?: unknown;
          reason?: unknown;
          commitSeq?: unknown;
          conflict?: unknown;
        })
      : {};
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  switch (body.state) {
    // A CONFLICT IS TERMINAL AND IT IS NOT A DENIAL (#1014, V7). Falling to
    // `retryable` would spin the seat's outbox against a row that will refuse
    // it every time; calling it a denial would lose the two numbers the member
    // needs to decide. It is the same verdict the device door gives, carried
    // across the peer transport unchanged.
    case "conflict":
      return {
        status: "conflict",
        reason:
          reason ?? "the edited row changed while this intent was offline",
        ...(isConflictWire(body.conflict) ? { conflict: body.conflict } : {}),
      };
    case "executed":
      return {
        status: "executed",
        ...(typeof body.commitSeq === "number"
          ? { commitSeq: body.commitSeq }
          : {}),
      };
    // A REFUSAL IS A DENIAL, not a retry. The origin judged the grant, the
    // signature or the payload and said no; asking again changes nothing, and
    // leaving the intent `sending` would spin the seat's outbox forever.
    case "denied":
    case "refused":
      return { status: "denied", reason: reason ?? "the origin refused it" };
    case "parked":
      return { status: "parked", ...(reason === undefined ? {} : { reason }) };
    default:
      return {
        status: "retryable",
        reason: `the origin answered ${response.status}`,
      };
  }
}
