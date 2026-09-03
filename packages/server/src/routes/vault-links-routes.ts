import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { PeerDial } from "../serve/peer-link-client.js";
import {
  encodeLinkTicket,
  parseLinkTicket,
  redeemLinkTicket,
} from "../serve/peer-link-client.js";
import type { VaultLink } from "../serve/vault-link-row.js";
import {
  isLinkApproved,
  partyIdForLinkedVault,
} from "../serve/vault-link-row.js";
import type { VaultLinksStore } from "../serve/vault-links-store.js";
import { readJson, sendJson } from "./route-helpers.js";

const LINKS_PATH = "/centraid/_gateway/links";
const TICKET_PATH = `${LINKS_PATH}/ticket`;
const REDEEM_PATH = `${LINKS_PATH}/redeem`;

export interface VaultLinksRouteDeps {
  enrollments: EnrollmentStore;
  store: VaultLinksStore;
  gatewayDatabase: GatewayDatabase;
  vaultPublicKey: (vaultId: string) => string | undefined;
  vaultName?: (vaultId: string) => string | undefined;
  ownerPartyFor?: (vaultId: string) => string | undefined;
  peer?: {
    localRoute: () => { endpointId?: string; relayHints: string[] };
    dial: PeerDial;
  };
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function linkDto(
  store: VaultLinksStore,
  link: VaultLink
): Record<string, unknown> {
  return {
    linkId: link.linkId,
    vaultA: link.vaultA,
    vaultB: link.vaultB,
    labelA: store.directoryEntry(link.vaultA)?.label ?? null,
    labelB: store.directoryEntry(link.vaultB)?.label ?? null,
    partyIdA: partyIdForLinkedVault(link, link.vaultA) ?? null,
    partyIdB: partyIdForLinkedVault(link, link.vaultB) ?? null,
    approvedByA: link.approvedByA,
    approvedByB: link.approvedByB,
    approved: isLinkApproved(link),
    remoteVaultId:
      store.routeFor(link.vaultA) === undefined
        ? store.routeFor(link.vaultB) === undefined
          ? null
          : link.vaultB
        : link.vaultA,
    revoked: link.revoked,
    createdAt: link.createdAt,
  };
}

async function handleMintTicket(
  req: IncomingMessage,
  res: ServerResponse,
  deps: VaultLinksRouteDeps,
  caller: { ownerId: string }
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: "invalid_body" });
  }
  const vaultId = typeof body.vaultId === "string" ? body.vaultId : undefined;
  if (!vaultId)
    return sendJson(res, 400, {
      error: "invalid_ticket_request",
      message: "vaultId is required",
    });
  if (deps.enrollments.owners.ownerOf(vaultId) !== caller.ownerId) {
    return sendJson(res, 404, { error: "not_found" });
  }
  const publicKey = deps.vaultPublicKey(vaultId);
  if (!publicKey) return sendJson(res, 404, { error: "not_found" });
  if (!deps.peer) {
    return sendJson(res, 503, {
      error: "peer_plane_unavailable",
      message:
        "this gateway cannot dial out, so a ticket it mints could never be redeemed",
    });
  }
  const route = deps.peer.localRoute();
  if (!route.endpointId) {
    return sendJson(res, 503, {
      error: "peer_plane_unavailable",
      message: "this gateway has no live dial route yet",
    });
  }
  const minted = deps.store.tickets.mint(vaultId, publicKey);
  const ticket = encodeLinkTicket({
    v: 1,
    kind: "centraid-link",
    vaultId,
    vaultPublicKey: publicKey,
    endpointTicket: deps.peer.dial.endpointTicketFor(
      route.endpointId,
      route.relayHints
    ),
    ticketId: minted.ticketId,
    secret: minted.secret,
  });
  return sendJson(res, 201, {
    vaultId,
    ticket,
    expiresAt: new Date(minted.expiresAt).toISOString(),
  });
}

const REDEEM_STATUS: Record<string, number> = {
  not_found: 404,
  protocol_refused: 409,
  bad_request: 400,
  unreachable: 200,
};

async function handleRedeemTicket(
  req: IncomingMessage,
  res: ServerResponse,
  deps: VaultLinksRouteDeps,
  caller: { ownerId: string }
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: "invalid_body" });
  }
  const vaultId = typeof body.vaultId === "string" ? body.vaultId : undefined;
  const raw = typeof body.ticket === "string" ? body.ticket : undefined;
  if (!vaultId || !raw)
    return sendJson(res, 400, {
      error: "invalid_ticket_request",
      message: "vaultId and ticket are required",
    });
  if (deps.enrollments.owners.ownerOf(vaultId) !== caller.ownerId) {
    return sendJson(res, 404, { error: "not_found" });
  }
  const publicKey = deps.vaultPublicKey(vaultId);
  if (!publicKey) return sendJson(res, 404, { error: "not_found" });
  const parsed = parseLinkTicket(raw);
  if (!parsed)
    return sendJson(res, 400, {
      error: "invalid_ticket",
      message: "not a Centraid link ticket",
    });
  if (!deps.peer) {
    return sendJson(res, 503, {
      error: "peer_plane_unavailable",
      message: "this gateway cannot dial out, so it cannot redeem a ticket",
    });
  }
  const localRoute = deps.peer.localRoute();
  const localOwnerPartyId = deps.ownerPartyFor?.(vaultId);
  const result = await redeemLinkTicket({
    ticket: parsed,
    links: deps.store,
    request: deps.peer.dial.request,
    localVault: { vaultId, publicKey },
    ...(localOwnerPartyId === undefined ? {} : { localOwnerPartyId }),
    localRoute: {
      endpointId: localRoute.endpointId ?? "",
      relayHints: localRoute.relayHints,
    },
    localLabel: deps.vaultName?.(vaultId) ?? vaultId,
  });
  if (result.state === "linked") {
    const full = deps.store.get(result.link.linkId);
    return sendJson(res, 201, {
      state: "linked",
      link: full ? linkDto(deps.store, full) : undefined,
    });
  }
  return sendJson(res, REDEEM_STATUS[result.state] ?? 400, result);
}

export function makeVaultLinksRouteHandler(
  deps: VaultLinksRouteDeps
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (
      url.pathname !== LINKS_PATH &&
      !url.pathname.startsWith(`${LINKS_PATH}/`)
    )
      return false;
    const deviceKey = callerDeviceKey(req);
    const caller = deviceKey ? deps.enrollments.ownerFor(deviceKey) : undefined;
    if (!caller) {
      return sendJson(res, 403, {
        error: "device_identity_required",
        message: "this route requires a proved iroh device identity",
      });
    }
    const owners = deps.enrollments.owners;
    const method = req.method ?? "GET";

    if (url.pathname === TICKET_PATH) {
      if (method !== "POST")
        return sendJson(res, 405, { error: "method_not_allowed" });
      return handleMintTicket(req, res, deps, caller);
    }
    if (url.pathname === REDEEM_PATH) {
      if (method !== "POST")
        return sendJson(res, 405, { error: "method_not_allowed" });
      return handleRedeemTicket(req, res, deps, caller);
    }

    if (url.pathname === LINKS_PATH) {
      if (method === "GET") {
        return sendJson(res, 200, {
          links: deps.store
            .listForOwner(caller.ownerId)
            .map((link) => linkDto(deps.store, link)),
        });
      }
      if (method !== "POST")
        return sendJson(res, 405, { error: "method_not_allowed" });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "invalid_body" });
      }
      const vaultId =
        typeof body.vaultId === "string" ? body.vaultId : undefined;
      const otherVaultId =
        typeof body.otherVaultId === "string" ? body.otherVaultId : undefined;
      if (!vaultId || !otherVaultId)
        return sendJson(res, 400, {
          error: "invalid_link",
          message: "vaultId and otherVaultId are required",
        });
      if (vaultId === otherVaultId)
        return sendJson(res, 400, {
          error: "invalid_link",
          message: "a vault cannot link to itself",
        });
      if (owners.ownerOf(vaultId) !== caller.ownerId)
        return sendJson(res, 404, { error: "not_found" });
      if (owners.ownerOf(otherVaultId) === undefined)
        return sendJson(res, 404, { error: "not_found" });
      const fromPublicKey = deps.vaultPublicKey(vaultId);
      const toPublicKey = deps.vaultPublicKey(otherVaultId);
      if (!fromPublicKey || !toPublicKey)
        return sendJson(res, 404, { error: "not_found" });
      const link = deps.store.propose({
        fromVaultId: vaultId,
        fromPublicKey,
        toVaultId: otherVaultId,
        toPublicKey,
        ...(deps.ownerPartyFor?.(vaultId)
          ? { fromPartyId: deps.ownerPartyFor(vaultId) }
          : {}),
        ...(deps.ownerPartyFor?.(otherVaultId)
          ? { toPartyId: deps.ownerPartyFor(otherVaultId) }
          : {}),
        ...(deps.vaultName?.(vaultId)
          ? { fromLabel: deps.vaultName(vaultId) }
          : {}),
        ...(deps.vaultName?.(otherVaultId)
          ? { toLabel: deps.vaultName(otherVaultId) }
          : {}),
      });
      return sendJson(res, 201, { link: linkDto(deps.store, link) });
    }

    const rest = url.pathname.slice(`${LINKS_PATH}/`.length).split("/");
    const linkId = decodeURIComponent(rest[0] ?? "");
    if (!linkId || rest.length !== 2) return false;
    const link = deps.store.get(linkId);
    if (!link) return sendJson(res, 404, { error: "not_found" });
    const callerSide =
      owners.ownerOf(link.vaultA) === caller.ownerId
        ? link.vaultA
        : owners.ownerOf(link.vaultB) === caller.ownerId
          ? link.vaultB
          : undefined;
    if (!callerSide) return sendJson(res, 404, { error: "not_found" });

    if (rest[1] === "approve") {
      if (method !== "POST")
        return sendJson(res, 405, { error: "method_not_allowed" });
      const approved = deps.store.approve(linkId, callerSide)!;
      return sendJson(res, 200, { link: linkDto(deps.store, approved) });
    }
    return false;
  };
}

export { LINKS_PATH };
