/*
 * The RECEIVING side of a remote give (#726 P3 decisions 7 and 9) —
 * `POST /centraid/_peer/edge/give`, `GET /centraid/_peer/edge/closure/:id`,
 * and `POST /centraid/_peer/edge/deny`. All three land here because THIS
 * gateway is the one being asked to do something: project a closure it was
 * just handed, re-serve one it already owns after a D9 'ask' was answered,
 * or learn that its own OUTGOING edge was refused.
 *
 * D9 runs BEFORE any byte moves and before the closure body is even trusted
 * enough to project: refuse writes nothing and answers denied (a state, not
 * an exception); ask writes only a pointer row and answers asked; accept
 * projects. Every derivative's bytes are sha256-verified against the name the
 * closure gave them before they ever reach the audience's CAS — untrusted
 * network input never gets adopted on the strength of its own say-so.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ProjectedItem,
  ShareVaultRef,
  WireClosure,
} from "@centraid/vault";
import { projectShareClosure, readShareClosure } from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import { recordPendingPulls } from "../serve/peer-blob-pull.js";
import {
  collectDerivativeBlobs,
  isWireClosureShape,
  isWireDerivativesShape,
  verifyDerivatives,
  writeDerivativeBytes,
} from "../serve/peer-closure-blobs.js";
import type { WireDerivativeBlob } from "../serve/peer-closure-blobs.js";
import { receiveSettingFor } from "../serve/peer-receive-settings.js";
import { readEdgeRow, updateStatus } from "./edges-reconcile.js";
import type { PeerIdentity } from "./peer-plane.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PEER_EDGE_GIVE_PATH = "/centraid/_peer/edge/give";
export const PEER_EDGE_CLOSURE_PATH_PREFIX = "/centraid/_peer/edge/closure/";
export const PEER_EDGE_DENY_PATH = "/centraid/_peer/edge/deny";

export interface PeerEdgeGiveDeps {
  gatewayDatabase: GatewayDatabase;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
}

function project(
  audience: ShareVaultRef,
  closure: WireClosure,
  derivatives: readonly WireDerivativeBlob[]
): { items: ProjectedItem[] } {
  writeDerivativeBytes(audience, derivatives);
  return projectShareClosure(audience.vault, closure, {
    sharedBy: `peer:${closure.originVaultId}`,
  });
}

export async function handlePeerEdgeGive(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerEdgeGiveDeps
): Promise<true> {
  // A total stranger (no live link at all) is refused before its body is
  // even parsed — a malformed body from someone with no link must still read
  // as `not_found`, never leak a `bad_request` that implies a link exists.
  if (!peer.linked) return sendJson(res, 404, { state: "not_found" });
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const edgeId = typeof body.edgeId === "string" ? body.edgeId : undefined;
  const itemType =
    typeof body.itemType === "string" ? body.itemType : undefined;
  if (!edgeId || !itemType || !isWireClosureShape(body.closure)) {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const closure = body.closure;
  // The closure's own `originVaultId` IS this request's vault claim — resolve
  // the link THROUGH it (audit #726 finding 2) rather than off the endpoint
  // alone, which two vaults co-hosted on one remote gateway would share.
  const link = peer.linkFor(closure.originVaultId);
  if (!link) return sendJson(res, 404, { state: "not_found" });
  const derivatives = isWireDerivativesShape(body.derivatives)
    ? body.derivatives
    : [];
  const setting = receiveSettingFor(
    deps.gatewayDatabase,
    link.linkId,
    link.localVaultId
  );
  if (setting === "refuse") {
    return sendJson(res, 200, {
      state: "denied",
      reason: "recipient is not accepting gives right now",
    });
  }
  if (setting === "ask") {
    deps.gatewayDatabase.run(
      `INSERT INTO peer_pending_gives
         (edge_id, link_id, peer_vault_id, local_vault_id, item_type, item_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (edge_id) DO NOTHING`,
      edgeId,
      link.linkId,
      link.peerVaultId,
      link.localVaultId,
      itemType,
      closure.items.length,
      new Date().toISOString()
    );
    return sendJson(res, 200, { state: "asked" });
  }
  const mismatch = verifyDerivatives(closure, derivatives);
  if (mismatch)
    return sendJson(res, 400, { state: "bad_request", detail: mismatch });
  const audience = deps.vaultFor(link.localVaultId);
  if (!audience) return sendJson(res, 404, { state: "not_found" });
  let result: { items: ProjectedItem[] };
  try {
    result = project(audience, closure, derivatives);
  } catch (error) {
    return sendJson(res, 400, {
      state: "bad_request",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  deps.gatewayDatabase.run(
    "DELETE FROM peer_pending_gives WHERE edge_id = ?",
    edgeId
  );
  recordPendingPulls(deps.gatewayDatabase, audience, {
    edgeId,
    linkId: link.linkId,
    localVaultId: link.localVaultId,
    originals: closure.blobs.filter((entry) => entry.rung === "original"),
  });
  return sendJson(res, 200, { state: "given", items: result.items });
}

/** The D9 'ask' → accept resume: the origin re-serves the same closure fresh. */
export async function handlePeerEdgeClosure(
  res: ServerResponse,
  peer: PeerIdentity,
  edgeId: string,
  deps: PeerEdgeGiveDeps
): Promise<true> {
  if (!peer.linked) return sendJson(res, 404, { state: "not_found" });
  const row = readEdgeRow(deps.gatewayDatabase, edgeId);
  if (!row || row.status === "denied" || row.status === "revoked") {
    return sendJson(res, 404, { state: "not_found" });
  }
  // The edge row is THIS gateway's own trusted bookkeeping — it already
  // names BOTH vaults, so the exact pair resolves the link precisely (audit
  // #726 finding 2: an endpoint alone cannot disambiguate two vaults
  // co-hosted on one remote gateway, and a remote-vault claim alone cannot
  // disambiguate two LOCAL vaults linked to the same remote one).
  const link = peer.linkForPair(row.origin_vault_id, row.audience_vault_id);
  if (!link) return sendJson(res, 404, { state: "not_found" });
  const origin = deps.vaultFor(row.origin_vault_id);
  if (!origin) return sendJson(res, 404, { state: "not_found" });
  let closure: WireClosure;
  let derivatives: WireDerivativeBlob[];
  try {
    closure = readShareClosure(origin.vault, {
      originVaultId: row.origin_vault_id,
      itemType: row.item_type,
      itemIds: JSON.parse(row.scope_json ?? "[]") as string[],
      crossOwner: true,
    });
    derivatives = collectDerivativeBlobs(origin, closure);
  } catch (error) {
    return sendJson(res, 400, {
      state: "bad_request",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  // Best-effort optimism: this gateway has now handed the closure over the
  // wire twice (or more); it has no way to learn whether the audience's
  // projection actually succeeds, so — same as the push path — reaching this
  // point IS this gateway's definition of "given".
  updateStatus(deps.gatewayDatabase, edgeId, "completed", null);
  return sendJson(res, 200, { state: "given", closure, derivatives });
}

/**
 * The D9 'refuse' → origin notification (#726 P3 decision 9, the gap this
 * closes): the AUDIENCE tells the ORIGIN its edge was declined so it lands
 * `denied` instead of `parked` forever. Reaches forward only — no reason, no
 * counts, nothing about the audience beyond "not this edge".
 */
export async function handlePeerEdgeDeny(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: Pick<PeerEdgeGiveDeps, "gatewayDatabase">
): Promise<true> {
  if (!peer.linked) return sendJson(res, 404, { state: "not_found" });
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const edgeId = typeof body.edgeId === "string" ? body.edgeId : undefined;
  if (!edgeId) return sendJson(res, 400, { state: "bad_request" });
  const row = readEdgeRow(deps.gatewayDatabase, edgeId);
  if (!row) return sendJson(res, 404, { state: "not_found" });
  // Same exact-pair resolution as `handlePeerEdgeClosure` (audit #726
  // finding 2): the row is THIS gateway's own bookkeeping, trusted for both
  // vault ids, not the wire's say-so.
  const link = peer.linkForPair(row.origin_vault_id, row.audience_vault_id);
  if (!link) return sendJson(res, 404, { state: "not_found" });
  // Idempotent: a completed or already-denied edge is left alone rather than
  // clobbered by a late-arriving (queued, retried) denial.
  if (row.status !== "completed" && row.status !== "denied") {
    updateStatus(
      deps.gatewayDatabase,
      edgeId,
      "denied",
      "recipient declined this share"
    );
  }
  return sendJson(res, 200, { state: "acknowledged" });
}
