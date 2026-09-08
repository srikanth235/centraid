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

import type { DatabaseSync } from "node:sqlite";

import { shareShapeId } from "@centraid/core/protocol";
import { forwardProjectedEdit, memberIntentBytes } from "@centraid/vault";
import type { MemberIntentEnvelope, ProjectedEditRoute } from "@centraid/vault";

import { PEER_REPLICA_INTENTS_PATH } from "../routes/peer-replica-route.js";
import type { ReplicaIntentBaseVersion } from "../routes/replica-intent-shape.js";
import type { PeerDial, PeerDialRoute } from "./peer-link-client.js";

/**
 * What the origin answered. `retryable` is a fact about REACH, never about the
 * intent: the seat's row stays `sending` and the next retry asks again.
 */
export interface ProjectedEditAnswer {
  status: "executed" | "denied" | "parked" | "retryable";
  reason?: string;
  /** The ORIGIN's canonical commit; the seat waits for it, not for a local one. */
  commitSeq?: number;
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
    baseVersions: [
      {
        entity: request.route.entity,
        rowId: request.route.originItemId,
        version: request.route.originRowVersion,
      },
    ],
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
        })
      : {};
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  switch (body.state) {
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
