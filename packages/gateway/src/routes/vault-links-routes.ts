/*
 * `/centraid/_gateway/links` — the same-machine "link ceremony" a
 * cross-owner edge needs before it may cross (#726 P2 §3), PLUS the
 * owner-facing door onto the remote half (audit #726 finding 1).
 *
 * Same-owner edges never reach this surface: owning both vaults already IS
 * the authorization, so nothing here applies to them. Propose/approve exist
 * only for the co-hosted cross-owner case (father→daughter, both vaults on
 * this one gateway) and write the SAME rows the remote ceremony writes — one
 * table, one answerer (D3) — differing only in that neither side needs a
 * route to reach the other.
 *
 * `ticket`/`redeem` are that remote ceremony's missing door: before this,
 * `PeerLinkTicketStore.mint` and `redeemLinkTicket` (`serve/peer-link-*.ts`)
 * were reachable only from tests and fixtures — no owner-facing route ever
 * called them. `ticket` mints a one-time capability for a vault the caller
 * owns (mirrors `propose`'s ownership check); `redeem` is the OTHER
 * gateway's owner pasting/scanning what `ticket` produced, and dials out
 * over `peerPlane.dial` (`serve/peer-dial.ts`) to actually run the ceremony
 * — `redeemLinkTicket` is the client, unchanged.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import {
  encodeLinkTicket,
  parseLinkTicket,
  redeemLinkTicket,
} from "../serve/peer-link-client.js";
import {
  isReceiveSetting,
  receiveSettingFor,
  setReceiveSetting,
} from "../serve/peer-receive-settings.js";
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
  /** Base64 identity public key of a vault on this gateway (P1). */
  vaultPublicKey: (vaultId: string) => string | undefined;
  /** A LOCAL vault's own display name (#726 P6 gap 3) — both sides of a
   *  same-machine link are already known, so `propose()` can label them
   *  immediately instead of leaving the link unnamed forever. Absent only in
   *  a test double with no registry; a link proposed without it is labeled
   *  `null`, same as before this gap closed. */
  vaultName?: (vaultId: string) => string | undefined;
  ownerPartyFor?: (vaultId: string) => string | undefined;
  /**
   * The remote ceremony's transport (audit #726 finding 1). Absent means
   * this build cannot dial out at all — `ticket` and `redeem` both answer a
   * typed refusal rather than minting a ticket that could never be
   * redeemed, or pretending to redeem one it cannot reach.
   */
  peer?: {
    /** This gateway's own dial route, embedded in a minted ticket so the
     *  OTHER side can reach back. */
    localRoute: () => { endpointId?: string; relayHints: string[] };
    dial: PeerDial;
  };
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function linkDto(link: VaultLink): Record<string, unknown> {
  return {
    linkId: link.linkId,
    vaultA: link.vaultA,
    vaultB: link.vaultB,
    // #726 P6 gap 3: the vault's own name/self-declared label, symmetric
    // with vaultA/vaultB — `null` when genuinely unknown (an older link
    // proposed before this field was recorded), never a raw id standing in
    // for a name. The People panel renders that honestly instead of
    // printing the id itself.
    labelA: link.labelA,
    labelB: link.labelB,
    partyIdA: partyIdForLinkedVault(link, link.vaultA) ?? null,
    partyIdB: partyIdForLinkedVault(link, link.vaultB) ?? null,
    approvedByA: link.approvedByA,
    approvedByB: link.approvedByB,
    approved: isLinkApproved(link),
    // Which side, if either, this gateway must route to reach.
    remoteVaultId:
      link.routeA === undefined
        ? link.routeB === undefined
          ? null
          : link.vaultB
        : link.vaultA,
    revoked: link.revoked,
    createdAt: link.createdAt,
  };
}

/**
 * Mint a one-time ticket for `vaultId` — the SHOWING half of the remote
 * ceremony (#726 P3 decision 3; the ticket shape and TTL are
 * `peer-link-tickets.ts`'s, unchanged). Authorization mirrors `propose`:
 * owning the vault IS the authorization, so a vault the caller does not own
 * is `not_found`, indistinguishable from one that does not exist.
 */
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

/**
 * Redeem a ticket someone showed — the SCANNING half. `vaultId` is the LOCAL
 * vault the caller owns and wants linked; the redeeming side dials the peer
 * using the ticket's own endpoint (`serve/peer-dial.ts` is the transport),
 * then `redeemLinkTicket` (`serve/peer-link-client.ts`) runs the proven
 * ceremony unchanged. A build with no peer plane wired at all refuses BEFORE
 * any of that, with the same typed capability refusal `handleMintTicket`
 * gives (503 `peer_plane_unavailable`). Past that gate, every one of
 * `redeemLinkTicket`'s own typed states is relayed as-is — its
 * `unreachable` answers 200 (a fact about the network, not about this build).
 */
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
  // A missing `deps.peer` is a CAPABILITY this build lacks — same refusal
  // `handleMintTicket` gives, and for the same reason: there is no dial to
  // attempt at all, which is a fact about this build, not about the network.
  // `redeemLinkTicket`'s OWN `state: "unreachable"` (below, via `REDEEM_STATUS`)
  // is the genuine network fact — a live peer plane that dialed out and got no
  // answer — and stays a distinct, 200-mapped state so a caller can always
  // tell "this build cannot do that" from "that machine is asleep".
  if (!deps.peer) {
    return sendJson(res, 503, {
      error: "peer_plane_unavailable",
      message: "this gateway cannot dial out, so it cannot redeem a ticket",
    });
  }
  const localRoute = deps.peer.localRoute();
  const localOwnerPartyId = deps.ownerPartyFor?.(vaultId);
  if (!localOwnerPartyId) return sendJson(res, 404, { error: "not_found" });
  const result = await redeemLinkTicket({
    ticket: parsed,
    links: deps.store,
    request: deps.peer.dial.request,
    localVault: { vaultId, publicKey },
    localOwnerPartyId,
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
      link: full ? linkDto(full) : undefined,
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

    // `ticket`/`redeem` are checked BEFORE the generic linkId sub-routes
    // below, which would otherwise treat "ticket"/"redeem" as a malformed
    // linkId and 404 without ever reaching these handlers.
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
          links: deps.store.listForOwner(caller.ownerId).map(linkDto),
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
      // Proposing requires owning the vault you propose FROM. The other
      // vault need only exist on this gateway — the whole point of a
      // cross-owner link is that someone else owns it.
      if (owners.ownerOf(vaultId) !== caller.ownerId)
        return sendJson(res, 404, { error: "not_found" });
      if (owners.ownerOf(otherVaultId) === undefined)
        return sendJson(res, 404, { error: "not_found" });
      // Every vault has an identity keypair (P1), so a local link records the
      // same two keys a remote one does. A vault that cannot produce its own
      // key is not linkable — refused, never linked keyless.
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
      return sendJson(res, 201, { link: linkDto(link) });
    }

    const rest = url.pathname.slice(`${LINKS_PATH}/`.length).split("/");
    const linkId = decodeURIComponent(rest[0] ?? "");
    if (!linkId || rest.length !== 2) return false;
    const link = deps.store.get(linkId);
    if (!link) return sendJson(res, 404, { error: "not_found" });
    // Whichever side the caller's owner actually holds. Owning neither side
    // is indistinguishable from the link not existing at all (topology
    // hiding: a link between two strangers' vaults is invisible).
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
      return sendJson(res, 200, { link: linkDto(approved) });
    }
    if (rest[1] === "receive-setting") {
      // D9 (#726 P3 decision 9): a vault sets ONLY its own receiving
      // preference — never the peer's — and reads it back the same way.
      if (method === "GET") {
        return sendJson(res, 200, {
          linkId,
          vaultId: callerSide,
          setting: receiveSettingFor(deps.gatewayDatabase, linkId, callerSide),
        });
      }
      if (method !== "PUT" && method !== "PATCH")
        return sendJson(res, 405, { error: "method_not_allowed" });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "invalid_body" });
      }
      if (!isReceiveSetting(body.setting)) {
        return sendJson(res, 400, {
          error: "invalid_receive_setting",
          message: "setting must be accept, ask, or refuse",
        });
      }
      setReceiveSetting(deps.gatewayDatabase, linkId, callerSide, body.setting);
      return sendJson(res, 200, {
        linkId,
        vaultId: callerSide,
        setting: body.setting,
      });
    }
    return false;
  };
}

export { LINKS_PATH };
