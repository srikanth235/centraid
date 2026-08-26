/*
 * Dialing half of the peer plane (#726 P3 d3+d4); transport injected;
 * nothing below knows about iroh.
 */

import { judgePeerHandshake, peerHello } from "@centraid/core/protocol";

import { routeAssertionBytes } from "./peer-route-assertion.js";
import type { LinkedPeer } from "./vault-link-row.js";
import type { VaultLinksStore } from "./vault-links-store.js";

export interface LinkTicketPayload {
  v: 1;
  kind: "centraid-link";
  /** The showing side's vault and its CURRENT identity key. */
  vaultId: string;
  vaultPublicKey: string;
  /** iroh EndpointTicket — address data, never identity. */ endpointTicket: string;
  ticketId: string;
  /** One-time secret, stored only hashed. */
  secret: string;
}

export type PeerRequest = (input: {
  endpointTicket: string;
  method: string;
  target: string;
  body?: unknown;
}) => Promise<{ status: number; json: unknown }>;

/** Where a dial goes. Address data, never identity (decision 1). */
export interface PeerDialRoute {
  endpointId: string;
  relayHints: string[];
}

/** Transport plus EndpointTicket minting — nothing below learns iroh. */
export interface PeerDial {
  request: PeerRequest;
  endpointTicketFor: (endpointId: string, relayHints: string[]) => string;
}

export type LinkCeremonyResult =
  | { state: "linked"; link: LinkedPeer }
  /** Unknown, expired, or redeemed — one answer for all three. */
  | { state: "not_found" }
  | { state: "protocol_refused"; detail: string }
  | { state: "bad_request"; detail: string }
  | { state: "unreachable"; detail: string };

export function encodeLinkTicket(payload: LinkTicketPayload): string {
  return JSON.stringify(payload);
}

/** Total parse: anything malformed is `undefined`. */
export function parseLinkTicket(raw: string): LinkTicketPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1 || value.kind !== "centraid-link") return undefined;
  const fields = [
    "vaultId",
    "vaultPublicKey",
    "endpointTicket",
    "ticketId",
    "secret",
  ] as const;
  for (const field of fields) {
    if (
      typeof value[field] !== "string" ||
      (value[field] as string).length === 0
    )
      return undefined;
  }
  return {
    v: 1,
    kind: "centraid-link",
    vaultId: value.vaultId as string,
    vaultPublicKey: value.vaultPublicKey as string,
    endpointTicket: value.endpointTicket as string,
    ticketId: value.ticketId as string,
    secret: value.secret as string,
  };
}

export interface RedeemLinkTicketDeps {
  ticket: LinkTicketPayload;
  links: VaultLinksStore;
  request: PeerRequest;
  /** What the peer will record about this side. */
  localVault: { vaultId: string; publicKey: string };
  localOwnerPartyId?: string;
  /** This side's dial route, so the peer can reach back. */
  localRoute: { endpointId: string; relayHints: string[] };
  localLabel: string;
  permissions?: Record<string, unknown>;
}

/**
 * Local row is written ONLY after the peer confirms — no half-link on either side.
 */
export async function redeemLinkTicket(
  deps: RedeemLinkTicketDeps
): Promise<LinkCeremonyResult> {
  let response: { status: number; json: unknown };
  try {
    response = await deps.request({
      endpointTicket: deps.ticket.endpointTicket,
      method: "POST",
      target: "/centraid/_peer/link/redeem",
      body: {
        ...peerHello(),
        ticketId: deps.ticket.ticketId,
        secret: deps.ticket.secret,
        vaultId: deps.localVault.vaultId,
        vaultPublicKey: deps.localVault.publicKey,
        ...(deps.localOwnerPartyId
          ? { ownerPartyId: deps.localOwnerPartyId }
          : {}),
        endpointId: deps.localRoute.endpointId,
        relayHints: deps.localRoute.relayHints,
        label: deps.localLabel,
        ...(deps.permissions === undefined
          ? {}
          : { permissions: deps.permissions }),
      },
    });
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const body =
    response.json !== null && typeof response.json === "object"
      ? (response.json as Record<string, unknown>)
      : {};
  if (body.state === "not_found" || response.status === 404) {
    return { state: "not_found" };
  }
  // The wall is mutual: we judge the far side as it judged us.
  const verdict = judgePeerHandshake(body);
  if (
    verdict.state === "protocol_refused" ||
    body.state === "protocol_refused"
  ) {
    return {
      state: "protocol_refused",
      detail:
        verdict.state === "protocol_refused"
          ? verdict.detail
          : String(body.detail ?? "peer refused this gateway's link protocol"),
    };
  }
  if (verdict.state !== "ok" || body.state !== "linked") {
    return { state: "bad_request", detail: "peer answer was not a link" };
  }
  const peerVaultId = body.vaultId;
  const peerPublicKey = body.vaultPublicKey;
  const peerOwnerPartyId = body.ownerPartyId;
  if (typeof peerVaultId !== "string" || typeof peerPublicKey !== "string") {
    return { state: "bad_request", detail: "peer answer named no vault" };
  }
  // Ticket identity disagreement = middleman rewrite.
  if (
    peerVaultId !== deps.ticket.vaultId ||
    peerPublicKey !== deps.ticket.vaultPublicKey
  ) {
    return {
      state: "bad_request",
      detail: "peer answer contradicts its ticket",
    };
  }
  const link = deps.links.recordPeer({
    localVaultId: deps.localVault.vaultId,
    localPublicKey: deps.localVault.publicKey,
    localLabel: deps.localLabel,
    peerVaultId,
    peerPublicKey,
    route: {
      endpointId: typeof body.endpointId === "string" ? body.endpointId : "",
      relayHints: Array.isArray(body.relayHints)
        ? body.relayHints.filter(
            (hint): hint is string => typeof hint === "string"
          )
        : [],
      assertedAt: Date.now(),
    },
    peerLabel: typeof body.label === "string" ? body.label : peerVaultId,
    permissions: {
      ...(typeof body.permissions === "object" && body.permissions !== null
        ? (body.permissions as Record<string, unknown>)
        : {}),
      ...(deps.localOwnerPartyId && typeof peerOwnerPartyId === "string"
        ? {
            commonsPartyIds: {
              [deps.localVault.vaultId]: deps.localOwnerPartyId,
              [peerVaultId]: peerOwnerPartyId,
            },
          }
        : {}),
    },
  });
  if (!link)
    return { state: "bad_request", detail: "link could not be stored" };
  return { state: "linked", link };
}

export interface PushRouteDeps {
  links: VaultLinksStore;
  request: PeerRequest;
  /** Sign as the LOCAL vault whose route moved. */
  signAsVault: (vaultId: string, bytes: Buffer) => Buffer | undefined;
  route: { vaultId: string; endpointId: string; relayHints: string[] };
  now?: () => number;
  endpointTicketFor: (endpointId: string, relayHints: string[]) => string;
}

export interface RoutePushOutcome {
  peerVaultId: string;
  /** Offline peers verify when they next reach us. */
  state: "accepted" | "stale" | "refused" | "offline";
}

/**
 * Push a signed route assertion to EVERY live link (decision 4, eager);
 * unreachable now = `offline`, not an error — idempotent and timestamped.
 */
export async function pushRouteAssertion(
  deps: PushRouteDeps
): Promise<RoutePushOutcome[]> {
  const ts = (deps.now ?? Date.now)();
  const claim = {
    vaultId: deps.route.vaultId,
    endpointId: deps.route.endpointId,
    relayHints: deps.route.relayHints,
    ts,
  };
  const signature = deps.signAsVault(claim.vaultId, routeAssertionBytes(claim));
  if (!signature) return [];
  const body = { ...claim, signature: signature.toString("base64") };
  const targets = deps.links.peersOf(claim.vaultId);
  // Peers are independent: one unreachable gateway delays no one.
  return Promise.all(
    targets.map(async (link): Promise<RoutePushOutcome> => {
      try {
        const response = await deps.request({
          endpointTicket: deps.endpointTicketFor(
            link.route.endpointId,
            link.route.relayHints
          ),
          method: "POST",
          target: "/centraid/_peer/route/assert",
          body,
        });
        const answer =
          response.json !== null && typeof response.json === "object"
            ? (response.json as Record<string, unknown>)
            : {};
        if (answer.state === "accepted")
          return { peerVaultId: link.peerVaultId, state: "accepted" };
        if (answer.state === "stale")
          return { peerVaultId: link.peerVaultId, state: "stale" };
        return { peerVaultId: link.peerVaultId, state: "refused" };
      } catch {
        return { peerVaultId: link.peerVaultId, state: "offline" };
      }
    })
  );
}
