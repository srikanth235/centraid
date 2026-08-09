/*
 * `DELETE /centraid/_gateway/edges/:edgeId` — the owner-facing revoke route
 * (#726 P6 gap 1). `closeLiveEdge` and `dropBorrowedEdge` existed
 * gateway-side, tested, and unreachable: no HTTP route called either, so the
 * People panel's "Stop lending" rendered permanently disabled.
 *
 * ONE route serves both directions, because the caller does not know in
 * advance which side of an edge id they hold — the same edge id names a
 * `share_edges` row at the origin and a DIFFERENT `borrowed_edges` row at the
 * audience, and one owner is never both for the same edge:
 *
 *   - a row in MY share_edges, mode 'live'  → I am the origin  → closeLiveEdge
 *   - a row in MY borrowed_edges            → I am the audience → dropBorrowedEdge
 *   - neither                               → not_found (topology hiding —
 *     a stranger's edge id and one this owner has no side of look identical)
 *
 * A snapshot (give) edge is refused TYPED, not silently ignored: the bytes
 * already landed, so there is no window left to close.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import type { ShareVaultRef } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { BorrowedDeps } from "../serve/lend-audience.js";
import { dropBorrowedEdge, readBorrowedEdge } from "../serve/lend-audience.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import { peerViewOf } from "../serve/vault-link-row.js";
import type { VaultLinksStore } from "../serve/vault-links-store.js";
import { closeLiveEdge } from "./edges-live.js";
import type { EdgeRow } from "./edges-reconcile.js";
import { readEdgeRow } from "./edges-reconcile.js";
import { EDGES_PATH } from "./edges-routes.js";
import { sendJson } from "./route-helpers.js";

export interface EdgeCloseRouteDeps {
  gatewayDatabase: GatewayDatabase;
  enrollments: EnrollmentStore;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  peerDial?: PeerDial;
  /** The borrowed slots — needed both to drop MY OWN borrowed edge and to
   *  close a CO-HOSTED one I lend (#726 P6 gap 1: no wire either way, D3). */
  borrowed?: BorrowedDeps;
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function closedEdgeDto(row: EdgeRow): Record<string, unknown> {
  return {
    edgeId: row.edge_id,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    updatedAt: row.updated_at,
  };
}

export function makeEdgeCloseRouteHandler(
  deps: EdgeCloseRouteDeps
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (!url.pathname.startsWith(`${EDGES_PATH}/`)) return false;
    const rest = url.pathname.slice(`${EDGES_PATH}/`.length).split("/");
    // Every other sub-path (`pending`, `:edgeId/answer`) belongs to a
    // sibling handler — this route is exactly `/edges/:edgeId`.
    if (rest.length !== 1 || !rest[0]) return false;
    if ((req.method ?? "GET") !== "DELETE") return false;
    const edgeId = decodeURIComponent(rest[0]);

    const deviceId = callerDeviceId(req);
    const owner = deviceId ? deps.enrollments.ownerFor(deviceId) : undefined;
    if (!deviceId || !owner)
      return sendJson(res, 403, { error: "device_identity_required" });
    const owners = deps.enrollments.owners;

    // The ORIGIN side: an edge this owner lends.
    const lent = readEdgeRow(deps.gatewayDatabase, edgeId);
    if (lent && owners.ownerOf(lent.origin_vault_id) === owner.ownerId) {
      if (lent.mode !== "live") {
        return sendJson(res, 400, {
          error: "not_a_live_edge",
          message:
            "a snapshot edge already landed its bytes — there is no window left to close",
        });
      }
      const origin = deps.vaultFor(lent.origin_vault_id);
      if (!origin) return sendJson(res, 404, { error: "not_found" });
      const link = deps.links.findPair(
        lent.origin_vault_id,
        lent.audience_vault_id
      );
      // The route TO the audience, from the origin's own side — undefined
      // means co-hosted (both vaults on this gateway, same-owner or not).
      const route = link
        ? peerViewOf(link, lent.origin_vault_id)?.route
        : undefined;
      const closed = await closeLiveEdge({
        db: deps.gatewayDatabase,
        row: lent,
        origin,
        ...(route ? { route } : {}),
        ...(deps.peerDial ? { peerDial: deps.peerDial } : {}),
        ...(deps.borrowed ? { borrowed: deps.borrowed } : {}),
        ...(link ? { linkId: link.linkId } : {}),
      });
      return sendJson(res, 200, closedEdgeDto(closed));
    }

    // The AUDIENCE side: an edge lent TO this owner.
    const borrowedIdentity = readBorrowedEdge(deps.gatewayDatabase, edgeId);
    if (
      borrowedIdentity &&
      owners.ownerOf(borrowedIdentity.audienceVaultId) === owner.ownerId
    ) {
      if (!deps.borrowed) {
        return sendJson(res, 409, {
          error: "borrowing_unavailable",
          message: "this gateway build cannot hold a borrowed scope",
        });
      }
      const dropped = dropBorrowedEdge(
        deps.borrowed,
        borrowedIdentity,
        "the audience dropped this share"
      );
      return sendJson(res, 200, { edgeId, state: dropped.state });
    }

    // Neither side, or the id names nothing at all — identical trace.
    return sendJson(res, 404, { error: "not_found" });
  };
}
