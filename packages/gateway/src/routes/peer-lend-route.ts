/*
 * The live-edge frames on the peer plane (#726 P4, P5). Five of them, and
 * the split between them is the P4/P5 idea in one place:
 *
 *   POST lend/open    origin → audience   "there is a window; here is a lease"
 *   GET  lend/bootstrap  audience → origin  the scoped projection, windowed
 *   GET  lend/changes    audience → origin  the tail, from the audience's cursor
 *   POST lend/intent   audience → origin  a queued write, run as the edge's
 *                                          grant identity (#726 P5) — the SAME
 *                                          frame answers a first attempt, a
 *                                          retry, and a later status poll
 *   POST lend/close   either direction    "this window is shut" — one frame,
 *                                          because revocation by the lender and
 *                                          a drop by the borrower are the same
 *                                          event seen from two sides
 *
 * Bytes always move audience-pulls-from-origin, the same way P3's ranged blob
 * pull does and for the same reason: the forwarder caps inbound bodies but
 * streams responses uncapped.
 *
 * Every refusal is a STATE. `not_found` covers an unknown edge, a revoked one,
 * and one belonging to a pair this caller is not — a probe maps nothing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { PEER_PLANE_PREFIX } from "@centraid/tunnel";
import type { Gateway as VaultGateway, ShareVaultRef } from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { BorrowedDeps } from "../serve/lend-audience.js";
import {
  dropBorrowedEdge,
  readBorrowedEdge,
  recordBorrowedEdge,
} from "../serve/lend-audience.js";
import { executeLentIntent } from "../serve/lend-intent.js";
import type { LendIntentRequest } from "../serve/lend-intent.js";
import { acceptLease, mintLease, parseLease } from "../serve/lend-lease.js";
import type { LeaseSigner } from "../serve/lend-lease.js";
import {
  lendBootstrapFrame,
  lendChangesFrame,
  readLentEdge,
  revokeLentEdge,
} from "../serve/lend-origin.js";
import type { PeerIdentity } from "./peer-plane.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PEER_LEND_OPEN_PATH = `${PEER_PLANE_PREFIX}lend/open`;
export const PEER_LEND_BOOTSTRAP_PATH = `${PEER_PLANE_PREFIX}lend/bootstrap`;
export const PEER_LEND_CHANGES_PATH = `${PEER_PLANE_PREFIX}lend/changes`;
export const PEER_LEND_INTENT_PATH = `${PEER_PLANE_PREFIX}lend/intent`;
export const PEER_LEND_CLOSE_PATH = `${PEER_PLANE_PREFIX}lend/close`;

export interface PeerLendDeps {
  gatewayDatabase: GatewayDatabase;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  /** `VaultRegistry.signAsVault` — the ONLY thing that mints a lease. */
  signAsVault: LeaseSigner;
  /** The audience side's borrowed slots; absent means this build cannot borrow. */
  borrowed?: BorrowedDeps;
  /**
   * The mounted origin vault's own `Gateway` (#726 P5) — the SAME instance
   * a local action runs through. Absent means this build cannot execute a
   * lend write; `lend/intent` then answers `not_found` like any other
   * unwired capability, never a silently-open write path.
   */
  gatewayFor?: (vaultId: string) => VaultGateway | undefined;
}

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { state: "not_found" });
}

/**
 * Resolve the edge a peer names, against the pair the QUIC handshake plus the
 * link actually proved. This is the "per-stream authorize" half of revocation:
 * once `lent_edges.revoked_at` is set, every subsequent frame is `not_found`
 * regardless of what the grant plane does.
 *
 * `lent_edges` is read FIRST — this gateway's own trusted bookkeeping, keyed
 * by `edgeId` alone — so it already names BOTH vaults for `peer.linkForPair`
 * (#726 audit finding 2: an endpoint alone cannot disambiguate two vaults
 * co-hosted on one remote gateway, and a remote-vault claim alone cannot
 * disambiguate two LOCAL vaults linked to the same remote one).
 */
function authorized(
  deps: PeerLendDeps,
  peer: PeerIdentity,
  edgeId: string
): { row: ReturnType<typeof readLentEdge>; origin: ShareVaultRef } | undefined {
  const row = readLentEdge(deps.gatewayDatabase, edgeId);
  if (!row || row.revoked_at !== null) return undefined;
  const link = peer.linkForPair(row.origin_vault_id, row.audience_vault_id);
  if (!link) return undefined;
  const origin = deps.vaultFor(row.origin_vault_id);
  return origin ? { row, origin } : undefined;
}

/** origin → audience: announce the window and hand over the first lease. */
export async function handlePeerLendOpen(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerLendDeps
): Promise<true> {
  if (!deps.borrowed || !peer.linked) return notFound(res);
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const edgeId = typeof body.edgeId === "string" ? body.edgeId : undefined;
  const itemType =
    typeof body.itemType === "string" ? body.itemType : undefined;
  if (!edgeId || !itemType) return sendJson(res, 400, { state: "bad_request" });
  // Unlabeled/malformed verbs default to 'read' — the safer half of the
  // pair, never a silently write-capable window (#726 P5).
  const verbs = body.verbs === "read+act" ? "read+act" : "read";
  const lease = parseLease(body.lease);
  if (!lease) return notFound(res);
  // No local row exists yet for a brand-new edge, so the lease's own
  // `originVaultId` IS this request's vault claim — resolve the link THROUGH
  // it (#726 audit finding 2: an endpoint alone cannot disambiguate two
  // vaults co-hosted on one remote gateway), then verify the lease against
  // the correctly-resolved key the link actually pinned. An unverifiable
  // lease is not a shorter lease — it is a caller who cannot prove they are
  // the vault this link pinned.
  const link = peer.linkFor(lease.originVaultId);
  if (
    !link ||
    !acceptLease(lease, {
      edgeId,
      originVaultId: link.peerVaultId,
      audienceVaultId: link.localVaultId,
      originPublicKey: link.peerPublicKey,
    })
  ) {
    return notFound(res);
  }
  recordBorrowedEdge(deps.gatewayDatabase, {
    edgeId,
    linkId: link.linkId,
    originVaultId: link.peerVaultId,
    audienceVaultId: link.localVaultId,
    originPublicKey: link.peerPublicKey,
    holderLabel: link.peerLabel ?? link.peerVaultId,
    itemType,
    verbs,
  });
  return sendJson(res, 200, { state: "opened" });
}

export function handlePeerLendBootstrap(
  res: ServerResponse,
  peer: PeerIdentity,
  query: URLSearchParams,
  deps: PeerLendDeps
): true {
  const edgeId = query.get("edgeId");
  if (!edgeId) return sendJson(res, 400, { state: "bad_request" });
  const found = authorized(deps, peer, edgeId);
  if (!found?.row) return notFound(res);
  const entityIdx = Number(query.get("entityIdx") ?? "0");
  if (!Number.isSafeInteger(entityIdx) || entityIdx < 0)
    return sendJson(res, 400, { state: "bad_request" });
  const frame = lendBootstrapFrame(
    deps.gatewayDatabase,
    found.origin,
    found.row,
    deps.signAsVault,
    { entityIdx, after: query.get("after") }
  );
  return sendJson(res, frame.state === "not_found" ? 404 : 200, frame);
}

export function handlePeerLendChanges(
  res: ServerResponse,
  peer: PeerIdentity,
  query: URLSearchParams,
  deps: PeerLendDeps
): true {
  const edgeId = query.get("edgeId");
  const epoch = query.get("epoch");
  const seq = Number(query.get("seq") ?? "");
  if (!edgeId || !epoch || !Number.isSafeInteger(seq) || seq < 0)
    return sendJson(res, 400, { state: "bad_request" });
  const found = authorized(deps, peer, edgeId);
  if (!found?.row) return notFound(res);
  const frame = lendChangesFrame(
    deps.gatewayDatabase,
    found.origin,
    found.row,
    deps.signAsVault,
    { epoch, seq }
  );
  return sendJson(res, frame.state === "not_found" ? 404 : 200, frame);
}

const LEND_INTENT_STATUS: Record<string, number> = {
  executed: 200,
  denied: 200,
  failed: 200,
  conflict: 200,
  parked: 202,
  in_flight: 202,
  bad_request: 400,
};

/**
 * The write-back frame (#726 P5): audience → origin, a queued intent run as
 * the edge's grant identity. The SAME request answers a first attempt, a
 * retry after a dropped connection, and a later poll for a parked
 * invocation's resolution — see `lend-intent.ts`'s dedupe-hit branch.
 */
export function handlePeerLendIntent(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerLendDeps
): true | Promise<true> {
  return (async () => {
    if (!deps.gatewayFor) return notFound(res);
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { state: "bad_request" });
    }
    const edgeId = typeof body.edgeId === "string" ? body.edgeId : undefined;
    if (!edgeId) return sendJson(res, 400, { state: "bad_request" });
    const found = authorized(deps, peer, edgeId);
    if (!found?.row) return notFound(res);
    const gateway = deps.gatewayFor(found.row.origin_vault_id);
    if (!gateway) return notFound(res);
    const lease = mintLease(deps.signAsVault, {
      edgeId,
      originVaultId: found.row.origin_vault_id,
      audienceVaultId: found.row.audience_vault_id,
    });
    if (!lease) return notFound(res);
    const request: LendIntentRequest = {
      intentId: typeof body.intentId === "string" ? body.intentId : "",
      action: typeof body.action === "string" ? body.action : "",
      input: body.input,
      payloadHash: typeof body.payloadHash === "string" ? body.payloadHash : "",
      baseVersions: body.baseVersions,
    };
    const frame = executeLentIntent(found.origin, gateway, found.row, request);
    return sendJson(res, LEND_INTENT_STATUS[frame.state] ?? 200, {
      ...frame,
      lease,
    });
  })();
}

/**
 * One frame, both directions. Arriving at the AUDIENCE it is the lender's
 * revocation and carries a deletion obligation; arriving at the ORIGIN it is
 * the borrower saying they dropped it, and closes the grant. Bilateral for
 * free — neither side needs a queue, and neither waits for a receipt.
 */
export async function handlePeerLendClose(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerLendDeps
): Promise<true> {
  if (!peer.linked) return notFound(res);
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const edgeId = typeof body.edgeId === "string" ? body.edgeId : undefined;
  if (!edgeId) return sendJson(res, 400, { state: "bad_request" });

  // Each row below is THIS gateway's own trusted bookkeeping, keyed by
  // `edgeId` alone — it already names BOTH vaults, so the exact pair
  // resolves the link precisely (#726 audit finding 2: an endpoint alone
  // cannot disambiguate two vaults co-hosted on one remote gateway, and a
  // remote-vault claim alone cannot disambiguate two LOCAL vaults linked to
  // the same remote one).
  const lent = readLentEdge(deps.gatewayDatabase, edgeId);
  if (lent) {
    const link = peer.linkForPair(lent.origin_vault_id, lent.audience_vault_id);
    if (link) {
      const origin = deps.vaultFor(lent.origin_vault_id);
      if (origin) revokeLentEdge(deps.gatewayDatabase, origin, edgeId);
      return sendJson(res, 200, { state: "closed" });
    }
  }

  const borrowed = deps.borrowed
    ? readBorrowedEdge(deps.gatewayDatabase, edgeId)
    : undefined;
  if (deps.borrowed && borrowed) {
    const link = peer.linkForPair(
      borrowed.audienceVaultId,
      borrowed.originVaultId
    );
    if (link) {
      dropBorrowedEdge(deps.borrowed, borrowed, "the lender closed this share");
      return sendJson(res, 200, { state: "closed" });
    }
  }
  return notFound(res);
}
