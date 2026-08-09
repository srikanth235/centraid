/*
 * The peer plane (issue #726 P3 decision 6) — `/centraid/_peer/*`.
 *
 * Everything a LINKED gateway may reach lives under this prefix and nothing
 * else does. Three invariants hold here regardless of what the transport did:
 *
 *  1. IDENTITY. A request is a peer request only if it carries the forwarder's
 *     peer proof. A device identity header is never read here, and a request
 *     without the proof is `not_found` — the route layer never infers a peer
 *     from a device, which is the whole point of the separate lane.
 *  2. CONFINEMENT. The handler re-checks `isPeerPlaneTarget` itself. The HTTP
 *     router resolves `..` before dispatch, so this check cannot be the only
 *     one — the forwarders' guards are load-bearing — but it does mean a
 *     future forwarder that forgets is still confined here.
 *  3. TOPOLOGY HIDING. Unknown link, revoked link, unknown vault, and unknown
 *     route all answer the same `not_found` state. A caller learns only about
 *     links it already holds.
 *
 * Refusals are STATES, never exceptions: the caller is another gateway's
 * protocol code, and a thrown error would reach it as a transport fault it
 * cannot act on.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { judgePeerHandshake, peerHello } from "@centraid/protocol";
import type { TokenBucket } from "@centraid/tunnel";
import {
  isPeerPlaneTarget,
  PEER_ENDPOINT_HEADER,
  PEER_PLANE_PREFIX,
  PEER_PROOF_HEADER,
} from "@centraid/tunnel";
import type { ShareVaultRef } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import { PEER_BLOB_CHUNK_PATH } from "../serve/peer-blob-route-path.js";
import {
  parseRouteAssertion,
  verifyRouteAssertion,
} from "../serve/peer-route-assertion.js";
import type { LinkedPeer } from "../serve/vault-link-row.js";
import type { VaultLinksStore } from "../serve/vault-links-store.js";
import { handlePeerBlobChunk } from "./peer-blob-route.js";
import {
  PEER_EDGE_CLOSURE_PATH_PREFIX,
  PEER_EDGE_DENY_PATH,
  PEER_EDGE_GIVE_PATH,
  handlePeerEdgeClosure,
  handlePeerEdgeDeny,
  handlePeerEdgeGive,
} from "./peer-edge-give-route.js";
import {
  PEER_LEND_BOOTSTRAP_PATH,
  PEER_LEND_CHANGES_PATH,
  PEER_LEND_CLOSE_PATH,
  PEER_LEND_INTENT_PATH,
  PEER_LEND_OPEN_PATH,
  handlePeerLendBootstrap,
  handlePeerLendChanges,
  handlePeerLendClose,
  handlePeerLendIntent,
  handlePeerLendOpen,
} from "./peer-lend-route.js";
import type { PeerLendDeps } from "./peer-lend-route.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PEER_LINK_REDEEM_PATH = `${PEER_PLANE_PREFIX}link/redeem`;
export const PEER_LINK_HELLO_PATH = `${PEER_PLANE_PREFIX}link/hello`;
export const PEER_ROUTE_ASSERT_PATH = `${PEER_PLANE_PREFIX}route/assert`;

export interface PeerPlaneDeps {
  /** The one link table — same rows a same-machine edge is judged against. */
  links: VaultLinksStore;
  /** Per-boot proof only this process's forwarders know. */
  peerProof: string;
  /** Base64 identity public key of a LOCAL vault (P1). */
  vaultPublicKey: (vaultId: string) => string | undefined;
  /** This gateway's current dial route, for the mutual half of the ceremony. */
  localRoute: () => { endpointId?: string; relayHints: string[] };
  /** How this side names itself to the peer. */
  localLabel: () => string;
  /** Per-link hygiene budget (threat 7). */
  budget?: TokenBucket;
  /**
   * A LOCAL vault a proved peer may be given into, or pulled bytes from
   * (#726 P3 decision 7: edge/give, edge/closure, blob/chunk). Absent from
   * the P3-transport build; every remote-give frame is `not_found` without it.
   */
  vaultFor?: (vaultId: string) => ShareVaultRef | undefined;
  /** This gateway's own `share_edges`/pending-give bookkeeping. */
  gatewayDatabase?: GatewayDatabase;
  /**
   * The LIVE-edge half (#726 P4). Absent from a build with no lending wired:
   * every `lend/*` frame is then `not_found`, exactly as an unknown path is.
   */
  lend?: Omit<PeerLendDeps, "gatewayDatabase" | "vaultFor">;
}

export interface PeerIdentity {
  endpointId: string;
  /** Coarse admission signal ONLY: does ANY live link route through this
   *  endpoint at all? A route uses this to refuse a total stranger before it
   *  bothers validating anything else about the request, so a malformed body
   *  from someone with no link at all still answers `not_found`, never
   *  `bad_request`. Never attribution — which SPECIFIC link a request
   *  concerns is always `linkFor`'s job. */
  linked: boolean;
  /**
   * Resolve the link this request concerns, given ONLY the vault the peer
   * claims to act as (audit #726 finding 2). An iroh endpoint is per-GATEWAY,
   * not per-vault (D1 invariant 2), so two vaults co-hosted on one remote
   * gateway share an `endpointId` — a route may NOT infer which link a
   * request means from the endpoint alone. Every caller of this must feed it
   * a vault id the REQUEST itself claims (a wire field, or this gateway's own
   * trusted row keyed by an id the request named) — never a guess. Returns
   * `undefined` for a claim naming a vault with no live, unrevoked link
   * routed through exactly this endpoint.
   *
   * Ambiguous the OTHER way when this gateway itself hosts more than one
   * local vault linked to the SAME peer vault — there is no wire field here
   * to pin the local side down. Use `linkForPair` instead whenever a trusted
   * row already names both vault ids; it is strictly more precise.
   */
  linkFor: (peerVaultId: string) => LinkedPeer | undefined;
  /**
   * Resolve the link for an EXACT (local vault, peer vault) pair, verified
   * against the endpoint this request actually proved. Use this whenever the
   * caller already has BOTH vault ids from its OWN trusted bookkeeping (an
   * edge/lend row keyed by an id the request named) — it is immune to both
   * directions of the co-hosting ambiguity `linkFor` alone is not.
   */
  linkForPair: (
    localVaultId: string,
    peerVaultId: string
  ) => LinkedPeer | undefined;
}

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { state: "not_found" });
}

function matchesProof(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string" || candidate.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(candidate, "utf8"),
    Buffer.from(expected, "utf8")
  );
}

/** A string field that must be present and non-empty; else the state is bad_request. */
function readString(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readHints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
}

export function makePeerPlaneHandler(deps: PeerPlaneDeps): RouteHandler {
  const identify = (req: IncomingMessage): PeerIdentity | undefined => {
    if (!matchesProof(req.headers[PEER_PROOF_HEADER], deps.peerProof)) {
      return undefined;
    }
    const endpointId = req.headers[PEER_ENDPOINT_HEADER];
    if (typeof endpointId !== "string" || endpointId.length === 0)
      return undefined;
    return {
      endpointId,
      linked: deps.links.isLinked(endpointId),
      linkFor: (peerVaultId) =>
        deps.links.peerForEndpointAndVault(endpointId, peerVaultId),
      linkForPair: (localVaultId, peerVaultId) => {
        const view = deps.links.peerForVault(peerVaultId, localVaultId);
        // The pair lookup is exact by construction; the endpoint check is
        // what stops a peer at the WRONG endpoint from riding a stale cached
        // route for a pair it does not currently hold.
        return view && view.route.endpointId === endpointId ? view : undefined;
      },
    };
  };

  const redeem = async (
    req: IncomingMessage,
    res: ServerResponse,
    peer: PeerIdentity
  ): Promise<true> => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { state: "bad_request" });
    }
    // The update wall runs BEFORE the ticket is touched: a version-mismatched
    // peer must not burn a one-time ticket it cannot finish redeeming.
    const verdict = judgePeerHandshake(body);
    if (verdict.state !== "ok") {
      return sendJson(res, verdict.state === "bad_request" ? 400 : 409, {
        ...verdict,
        ...peerHello(),
      });
    }
    const ticketId = readString(body, "ticketId");
    const secret = readString(body, "secret");
    const peerVaultId = readString(body, "vaultId");
    const peerPublicKey = readString(body, "vaultPublicKey");
    const claimedEndpoint = readString(body, "endpointId");
    if (!ticketId || !secret || !peerVaultId || !peerPublicKey) {
      return sendJson(res, 400, { state: "bad_request" });
    }
    // The redemption binds to the endpoint the QUIC handshake PROVED. A body
    // that names a different one is a relay attempt, not a ceremony.
    if (claimedEndpoint !== undefined && claimedEndpoint !== peer.endpointId) {
      return sendJson(res, 400, { state: "bad_request" });
    }
    const link = deps.links.redeem({
      ticketId,
      secret,
      peerVaultId,
      peerPublicKey,
      // The route binds to the endpoint the QUIC handshake PROVED, never the
      // body's claim.
      route: {
        endpointId: peer.endpointId,
        relayHints: readHints(body.relayHints),
        assertedAt: Date.now(),
      },
      peerLabel: readString(body, "label") ?? peerVaultId,
      localLabel: deps.localLabel(),
      ...(typeof body.permissions === "object" && body.permissions !== null
        ? { permissions: body.permissions as Record<string, unknown> }
        : {}),
    });
    // Unknown, expired, already-burned, and wrong-secret are one state: a
    // scanner learns nothing about tickets it does not hold.
    if (!link) return notFound(res);
    const publicKey = deps.vaultPublicKey(link.localVaultId);
    if (!publicKey) return notFound(res);
    const route = deps.localRoute();
    return sendJson(res, 200, {
      state: "linked",
      ...peerHello(),
      vaultId: link.localVaultId,
      vaultPublicKey: publicKey,
      ...(route.endpointId === undefined
        ? {}
        : { endpointId: route.endpointId }),
      relayHints: route.relayHints,
      label: link.myLabel ?? link.localVaultId,
      permissions: link.permissions,
    });
  };

  const assertRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    peer: PeerIdentity
  ): Promise<true> => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { state: "bad_request" });
    }
    const assertion = parseRouteAssertion(body);
    if (!assertion) return sendJson(res, 400, { state: "bad_request" });
    /*
     * A rotated peer dials from a NEW EndpointId, so the caller is very likely
     * unrecognised here — that is exactly the case this route exists for. The
     * authority is the vault SIGNATURE, plus the requirement that the asserted
     * endpoint is the one actually dialing, which stops a third party from
     * replaying an old assertion to point this gateway somewhere else.
     */
    if (assertion.endpointId !== peer.endpointId) {
      return sendJson(res, 400, { state: "bad_request" });
    }
    const link = deps.links.peerForVault(assertion.vaultId);
    if (!link) return notFound(res);
    if (!verifyRouteAssertion(assertion, link.peerPublicKey)) {
      // Signed with the wrong key: the link stays pointed where it was.
      return sendJson(res, 403, { state: "bad_signature" });
    }
    const moved = deps.links.recordRoute({
      peerVaultId: assertion.vaultId,
      peerEndpointId: assertion.endpointId,
      peerRelayHints: assertion.relayHints,
      assertedAt: assertion.ts,
      signature: assertion.signature,
    });
    // A stale assertion verifies but does not move the cache; saying so keeps
    // the sender from retrying a message that will never win.
    return sendJson(res, 200, { state: moved ? "accepted" : "stale" });
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const target = req.url ?? "";
    if (!target.startsWith(PEER_PLANE_PREFIX)) return false;
    if (!isPeerPlaneTarget(target)) return notFound(res);
    const peer = identify(req);
    if (!peer) return notFound(res);
    if (deps.budget && !deps.budget.take(peer.endpointId)) {
      return sendJson(res, 429, { state: "rate_limited" });
    }
    const pathname = target.split(/[?#]/u)[0] ?? "";
    const method = (req.method ?? "GET").toUpperCase();
    if (pathname === PEER_LINK_HELLO_PATH && method === "GET") {
      // Deliberately says nothing about vaults, links, or owners.
      return sendJson(res, 200, { state: "ready", ...peerHello() });
    }
    if (pathname === PEER_LINK_REDEEM_PATH && method === "POST") {
      return redeem(req, res, peer);
    }
    if (pathname === PEER_ROUTE_ASSERT_PATH && method === "POST") {
      return assertRoute(req, res, peer);
    }
    // The D9 refusal notice (#726 P3 decision 9) only touches this gateway's
    // OWN `share_edges` bookkeeping — no local vault needed, unlike give.
    if (
      deps.gatewayDatabase &&
      pathname === PEER_EDGE_DENY_PATH &&
      method === "POST"
    ) {
      return handlePeerEdgeDeny(req, res, peer, {
        gatewayDatabase: deps.gatewayDatabase,
      });
    }
    // The remote-give frames (#726 P3 decision 7) need a local vault + this
    // gateway's own edge bookkeeping; a build wired with neither answers
    // `not_found` for all three exactly as it would for an unknown path.
    if (deps.vaultFor && deps.gatewayDatabase && deps.lend) {
      const lendDeps: PeerLendDeps = {
        ...deps.lend,
        vaultFor: deps.vaultFor,
        gatewayDatabase: deps.gatewayDatabase,
      };
      if (pathname === PEER_LEND_OPEN_PATH && method === "POST")
        return handlePeerLendOpen(req, res, peer, lendDeps);
      if (pathname === PEER_LEND_CLOSE_PATH && method === "POST")
        return handlePeerLendClose(req, res, peer, lendDeps);
      if (pathname === PEER_LEND_INTENT_PATH && method === "POST")
        return handlePeerLendIntent(req, res, peer, lendDeps);
      if (method === "GET") {
        const query = new URL(target, "http://gateway.local").searchParams;
        if (pathname === PEER_LEND_BOOTSTRAP_PATH)
          return handlePeerLendBootstrap(res, peer, query, lendDeps);
        if (pathname === PEER_LEND_CHANGES_PATH)
          return handlePeerLendChanges(res, peer, query, lendDeps);
      }
    }
    if (deps.vaultFor && deps.gatewayDatabase) {
      const giveDeps = {
        vaultFor: deps.vaultFor,
        gatewayDatabase: deps.gatewayDatabase,
      };
      if (pathname === PEER_EDGE_GIVE_PATH && method === "POST") {
        return handlePeerEdgeGive(req, res, peer, giveDeps);
      }
      if (
        pathname.startsWith(PEER_EDGE_CLOSURE_PATH_PREFIX) &&
        method === "GET"
      ) {
        const edgeId = decodeURIComponent(
          pathname.slice(PEER_EDGE_CLOSURE_PATH_PREFIX.length)
        );
        if (!edgeId) return notFound(res);
        return handlePeerEdgeClosure(res, peer, edgeId, giveDeps);
      }
      if (pathname === PEER_BLOB_CHUNK_PATH && method === "GET") {
        const query = new URL(target, "http://gateway.local").searchParams;
        return handlePeerBlobChunk(res, peer, query, {
          gatewayDatabase: deps.gatewayDatabase,
          blobsFor: (vaultId) => deps.vaultFor!(vaultId)?.blobs.local,
          ...(deps.lend ? { signAsVault: deps.lend.signAsVault } : {}),
        });
      }
    }
    // Every other peer-plane path — including the ones later phases add and
    // this build does not have — is nothing to this caller.
    return notFound(res);
  };
}
