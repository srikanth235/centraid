/*
 * THE MEMBER WRITE DOOR (#929). A member with an `edit` grant sends a SIGNED
 * intent; the ORIGIN executes it as the single writer of the container. Kept
 * beside `peer-replica-route.ts` rather than inside it: admission is that
 * module's contract, and this one is what happens after it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { memberIntentExpired, verifyMemberIntent } from "@centraid/vault";
import type { MemberIntentEnvelope } from "@centraid/vault";

import { executeMemberIntent } from "./member-intent-exec.js";
import type { PeerIdentity } from "./peer-plane.js";
import { admitAtOrigin } from "./peer-replica-route.js";
import type { PeerReplicaDeps } from "./peer-replica-route.js";
import { parseBaseVersions } from "./replica-intent-shape.js";
import { readJson, sendJson } from "./route-helpers.js";

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
  let envelope: MemberIntentEnvelope | undefined;
  try {
    envelope = readEnvelope(body);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
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
  // AFTER THE SIGNATURE, BEFORE THE WRITE (#1014, V7). The window is part of
  // the signed bytes, so checking it before verifying would be checking a
  // number anyone could have written. A captured envelope presented past its
  // own expiry is refused here and never reaches the vault; the member's
  // remedy is the same one an aged-out outcome asks for — compose it again
  // against a base they can still see.
  if (memberIntentExpired(envelope))
    return sendJson(res, 409, {
      state: "refused",
      error: "expired",
      intentId: envelope.intentId,
      reason: "this signed change waited too long to be presented",
    });
  const answer = executeMemberIntent(admission, envelope, {
    gatewayFor: (vaultId) => deps.gatewayFor?.(vaultId),
    credentialFor: (vaultId) => deps.credentialFor?.(vaultId),
    memberLabel: link.peerLabel ?? undefined,
    ownerLabel: link.myLabel ?? undefined,
  });
  return sendJson(res, answer.status, answer.body);
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
  const baseVersions = parseBaseVersions(body.baseVersions);
  return {
    intentId,
    shapeId,
    originVaultId,
    memberVaultId,
    appId,
    action,
    input: body.input,
    // VALIDATED, NOT CAST (#1014, V7). This handed `body.baseVersions` straight
    // through as whatever shape it happened to be, and nothing downstream read
    // it — now that the origin CHECKS it, a malformed row has to be a 400 and
    // not a comparison against `undefined`. `parseBaseVersions` is the same
    // parser the device door uses, and it throws.
    ...(baseVersions.length > 0 ? { baseVersions } : {}),
    ...(read("expiresAt") ? { expiresAt: read("expiresAt") as string } : {}),
    ...(read("nonce") ? { nonce: read("nonce") as string } : {}),
  };
}
