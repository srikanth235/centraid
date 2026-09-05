/*
 * THE MEMBER WRITE DOOR (#929). A member with an `edit` grant sends a SIGNED
 * intent; the ORIGIN executes it as the single writer of the container. Kept
 * beside `peer-replica-route.ts` rather than inside it: admission is that
 * module's contract, and this one is what happens after it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  currentReplicaLogState,
  judgeMemberIntent,
  partiesBoundToVault,
  verifyMemberIntent,
  writeReceipt,
} from "@centraid/vault";
import type { MemberIntentEnvelope } from "@centraid/vault";

import type { PeerIdentity } from "./peer-plane.js";
import { admitAtOrigin } from "./peer-replica-route.js";
import type { Admission, PeerReplicaDeps } from "./peer-replica-route.js";
import { readJson, sendJson } from "./route-helpers.js";

/** One purpose for every member write, so the receipts are one band. */
export const MEMBER_INTENT_PURPOSE = "dpv:ServiceProvision";

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { state: "not_found" });
}

/**
 * ORIGIN door: a member's SIGNED write (#929).
 *
 * The origin is the single writer of the container, so the member never writes
 * into their own copy and hopes it converges. What arrives is an intent; what
 * the origin does is execute it under its OWN credential and write a receipt
 * that names the member, because the person who composed the change and the
 * credential that carried it are different facts.
 *
 * A confirmation-gated command PARKS, and the answer says who it waits on with
 * the label from the link — so the member reads a person, not a vault id.
 */
export async function handlePeerReplicaIntent(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerReplicaDeps
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const envelope = readEnvelope(body);
  if (!envelope) return sendJson(res, 400, { state: "bad_request" });
  const params = new URLSearchParams({
    originVaultId: envelope.originVaultId,
    audienceVaultId: envelope.memberVaultId,
    shapeId: envelope.shapeId,
  });
  const admission = admitAtOrigin(peer, params, deps);
  if (!admission) return notFound(res);
  const link = peer.linkForPair(envelope.originVaultId, envelope.memberVaultId);
  const signature = typeof body.signature === "string" ? body.signature : "";
  // ATTRIBUTION, not admission: the link already admitted the request, and
  // this proves WHICH vault composed it. A bad signature is a refusal with a
  // reason, never a 404 — the peer is linked and needs to know what to fix.
  if (!link || !verifyMemberIntent(envelope, link.peerPublicKey, signature))
    return sendJson(res, 403, {
      state: "refused",
      reason: "the member's vault signature does not verify",
    });
  const memberPartyIds = partiesBoundToVault(
    admission.origin.vault,
    envelope.memberVaultId
  );
  const verdict = judgeMemberIntent(admission.origin, {
    action: envelope.action,
    commandInput: (envelope.input ?? {}) as Record<string, unknown>,
    memberPartyIds,
  });
  if (verdict.state === "refused")
    return sendJson(res, 200, {
      state: "denied",
      intentId: envelope.intentId,
      reason: verdict.reason,
    });
  const gateway = deps.gatewayFor?.(envelope.originVaultId);
  const credential = deps.credentialFor?.(envelope.originVaultId);
  if (!gateway || !credential) return notFound(res);
  const memberLabel = link.peerLabel ?? envelope.memberVaultId;
  const result = gateway.invoke(credential, {
    command: envelope.action,
    input: (envelope.input ?? {}) as Record<string, unknown>,
    intentId: envelope.intentId,
    // The origin is the single WRITER, not the AUTHOR: a confirmation the
    // owner set over this command must fire, and the parked payload has to
    // carry who it is for.
    onBehalfOfMember: { vaultId: envelope.memberVaultId, label: memberLabel },
  });
  writeReceipt(admission.origin.audit, {
    authorityId: admission.grantId,
    invocationId: null,
    action: `act ${envelope.action}`,
    objectType: verdict.route.containerType,
    objectId: verdict.route.containerId,
    decision: result.status === "denied" ? "deny" : "allow",
    detail: {
      // THE MEMBER, not the credential that executed it.
      memberVaultId: envelope.memberVaultId,
      memberLabel,
      memberPartyIds,
      intentId: envelope.intentId,
      shapeId: envelope.shapeId,
      outcome: result.status,
    },
  });
  if (result.status === "parked")
    return sendJson(res, 202, {
      state: "parked",
      intentId: envelope.intentId,
      reason: "reason" in result ? result.reason : undefined,
      waitingOn: { seat: "owner", label: link.myLabel ?? undefined },
    });
  if (result.status !== "executed")
    return sendJson(res, 200, {
      state: "denied",
      intentId: envelope.intentId,
      reason: "reason" in result ? result.reason : "the origin refused it",
    });
  return sendJson(res, 200, {
    state: "executed",
    intentId: envelope.intentId,
    // G1: the ORIGIN versions this answer stands for. The member's seat drops
    // its pending row only once its lineage carries them.
    answeredVersions: answeredVersionsFor(admission, verdict.route),
  });
}

function readEnvelope(
  body: Record<string, unknown>
): MemberIntentEnvelope | undefined {
  const read = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const intentId = read("intentId");
  const shapeId = read("shapeId");
  const originVaultId = read("originVaultId");
  const memberVaultId = read("memberVaultId");
  const appId = read("appId");
  const action = read("action");
  if (
    !intentId ||
    !shapeId ||
    !originVaultId ||
    !memberVaultId ||
    !appId ||
    !action ||
    !("input" in body)
  )
    return undefined;
  return {
    intentId,
    shapeId,
    originVaultId,
    memberVaultId,
    appId,
    action,
    input: body.input,
    ...(Array.isArray(body.baseVersions)
      ? {
          baseVersions:
            body.baseVersions as MemberIntentEnvelope["baseVersions"],
        }
      : {}),
  };
}

function answeredVersionsFor(
  admission: Admission,
  route: { containerType: string; containerId: string }
): { shapeId: string; entity: string; rowId: string; version: number }[] {
  const state = currentReplicaLogState(admission.origin.vault);
  const row = admission.origin.vault
    .prepare(
      `SELECT MAX(seq) AS seq FROM replica_change
        WHERE epoch = ? AND entity = ? AND row_id = ?`
    )
    .get(state.epoch, route.containerType, route.containerId) as {
    seq: number | null;
  };
  return row.seq === null
    ? []
    : [
        {
          shapeId: admission.shapeId,
          entity: route.containerType,
          rowId: route.containerId,
          version: row.seq,
        },
      ];
}
