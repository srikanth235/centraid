import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { judgePeerHandshake, peerHello } from "@centraid/core/protocol";
import type { TokenBucket } from "@centraid/tunnel";
import {
  isPeerPlaneTarget,
  PEER_ENDPOINT_HEADER,
  PEER_PLANE_PREFIX,
  PEER_PROOF_HEADER,
} from "@centraid/tunnel";
import type { ExecuteCommonsCommandInput } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import {
  parseRouteAssertion,
  verifyRouteAssertion,
} from "../serve/peer-route-assertion.js";
import type { LinkedPeer } from "../serve/vault-link-row.js";
import type { VaultLinksStore } from "../serve/vault-links-store.js";
import {
  handlePeerCommonsBlob,
  handlePeerCommonsBlobAuthorize,
  handlePeerCommonsBootstrap,
  handlePeerCommonsCommand,
  handlePeerCommonsClaim,
  handlePeerCommonsInvite,
  handlePeerCommonsRefuse,
  PEER_COMMONS_BLOB_AUTH_PATH,
  PEER_COMMONS_BLOB_PATH,
  PEER_COMMONS_BOOTSTRAP_PATH_PREFIX,
  PEER_COMMONS_COMMAND_PATH,
  PEER_COMMONS_CLAIM_PATH,
  PEER_COMMONS_INVITE_PATH,
  PEER_COMMONS_REFUSE_PATH,
} from "./peer-commons-route.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PEER_LINK_REDEEM_PATH = `${PEER_PLANE_PREFIX}link/redeem`;
export const PEER_LINK_HELLO_PATH = `${PEER_PLANE_PREFIX}link/hello`;
export const PEER_ROUTE_ASSERT_PATH = `${PEER_PLANE_PREFIX}route/assert`;

export interface PeerPlaneDeps {
  links: VaultLinksStore;
  peerProof: string;
  vaultPublicKey: (vaultId: string) => string | undefined;
  ownerPartyFor?: (vaultId: string) => string | undefined;
  localRoute: () => { endpointId?: string; relayHints: string[] };
  localLabel: () => string;
  budget?: TokenBucket;
  commonsVaultFor?: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["steward"] | undefined;
  commonsGatewayFor?: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["gateway"] | undefined;
  commonsCredentialFor?: (
    vaultId: string
  ) => ExecuteCommonsCommandInput["credential"] | undefined;
}

export interface PeerIdentity {
  endpointId: string;
  linked: boolean;
  linkFor: (peerVaultId: string) => LinkedPeer | undefined;
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
    const peerOwnerPartyId = readString(body, "ownerPartyId");
    const claimedEndpoint = readString(body, "endpointId");
    if (!ticketId || !secret || !peerVaultId || !peerPublicKey) {
      return sendJson(res, 400, { state: "bad_request" });
    }
    if (deps.vaultPublicKey(peerVaultId) !== undefined) {
      return sendJson(res, 400, { state: "bad_request" });
    }
    if (claimedEndpoint !== undefined && claimedEndpoint !== peer.endpointId) {
      return sendJson(res, 400, { state: "bad_request" });
    }
    let link = deps.links.redeem({
      ticketId,
      secret,
      peerVaultId,
      peerPublicKey,
      route: {
        endpointId: peer.endpointId,
        relayHints: readHints(body.relayHints),
        assertedAt: Date.now(),
      },
      peerLabel: readString(body, "label") ?? peerVaultId,
      localLabel: deps.localLabel(),
      permissions: {
        ...(typeof body.permissions === "object" && body.permissions !== null
          ? (body.permissions as Record<string, unknown>)
          : {}),
        ...(peerOwnerPartyId
          ? { commonsPartyIds: { [peerVaultId]: peerOwnerPartyId } }
          : {}),
      },
    });
    if (!link) return notFound(res);
    const publicKey = deps.vaultPublicKey(link.localVaultId);
    const ownerPartyId = deps.ownerPartyFor?.(link.localVaultId);
    if (!publicKey) return notFound(res);
    if (ownerPartyId && peerOwnerPartyId)
      link =
        deps.links.recordCommonsParties({
          localVaultId: link.localVaultId,
          localPartyId: ownerPartyId,
          peerVaultId: link.peerVaultId,
          peerPartyId: peerOwnerPartyId,
        }) ?? link;
    const route = deps.localRoute();
    return sendJson(res, 200, {
      state: "linked",
      ...peerHello(),
      vaultId: link.localVaultId,
      vaultPublicKey: publicKey,
      ...(ownerPartyId ? { ownerPartyId } : {}),
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
    if (assertion.endpointId !== peer.endpointId) {
      return sendJson(res, 400, { state: "bad_request" });
    }
    const link = deps.links.peerForVault(assertion.vaultId);
    if (!link) return notFound(res);
    if (!verifyRouteAssertion(assertion, link.peerPublicKey)) {
      return sendJson(res, 403, { state: "bad_signature" });
    }
    const moved = deps.links.recordRoute({
      peerVaultId: assertion.vaultId,
      peerEndpointId: assertion.endpointId,
      peerRelayHints: assertion.relayHints,
      assertedAt: assertion.ts,
      signature: assertion.signature,
    });
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
      return sendJson(res, 200, { state: "ready", ...peerHello() });
    }
    if (pathname === PEER_LINK_REDEEM_PATH && method === "POST") {
      return redeem(req, res, peer);
    }
    if (pathname === PEER_ROUTE_ASSERT_PATH && method === "POST") {
      return assertRoute(req, res, peer);
    }
    if (
      deps.commonsVaultFor &&
      deps.commonsGatewayFor &&
      deps.commonsCredentialFor
    ) {
      const commonsDeps = {
        vaultFor: deps.commonsVaultFor,
        gatewayFor: deps.commonsGatewayFor,
        credentialFor: deps.commonsCredentialFor,
      };
      if (
        pathname.startsWith(PEER_COMMONS_BOOTSTRAP_PATH_PREFIX) &&
        method === "GET"
      ) {
        const grantId = decodeURIComponent(
          pathname.slice(PEER_COMMONS_BOOTSTRAP_PATH_PREFIX.length)
        );
        if (!grantId) return notFound(res);
        return handlePeerCommonsBootstrap(
          res,
          peer,
          grantId,
          new URL(target, "http://gateway.local").searchParams,
          commonsDeps
        );
      }
      if (pathname === PEER_COMMONS_BLOB_AUTH_PATH && method === "GET")
        return handlePeerCommonsBlobAuthorize(
          res,
          peer,
          new URL(target, "http://gateway.local").searchParams,
          commonsDeps
        );
      if (pathname === PEER_COMMONS_BLOB_PATH && method === "GET")
        return handlePeerCommonsBlob(
          res,
          peer,
          new URL(target, "http://gateway.local").searchParams,
          commonsDeps
        );
      if (pathname === PEER_COMMONS_COMMAND_PATH && method === "POST")
        return handlePeerCommonsCommand(req, res, peer, commonsDeps);
      if (pathname === PEER_COMMONS_INVITE_PATH && method === "POST")
        return handlePeerCommonsInvite(req, res, peer, commonsDeps);
      if (pathname === PEER_COMMONS_CLAIM_PATH && method === "POST")
        return handlePeerCommonsClaim(req, res, peer, commonsDeps);
      if (pathname === PEER_COMMONS_REFUSE_PATH && method === "POST")
        return handlePeerCommonsRefuse(req, res, peer, commonsDeps);
    }
    return notFound(res);
  };
}
