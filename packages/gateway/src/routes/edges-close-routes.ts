/*
 * `DELETE /centraid/_gateway/edges/:edgeId` — the owner-facing revoke route
 * (#731). Give is a completed receiver-owned copy, so it cannot be revoked;
 * commons revocation is vault-resident and has its own compiler surface.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { EdgeRow } from "./edges-reconcile.js";
import { readEdgeRow } from "./edges-reconcile.js";
import { EDGES_PATH } from "./edges-routes.js";
import { sendJson } from "./route-helpers.js";

export interface EdgeCloseRouteDeps {
  gatewayDatabase: GatewayDatabase;
  enrollments: EnrollmentStore;
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

    const edge = readEdgeRow(deps.gatewayDatabase, edgeId);
    if (edge && owners.ownerOf(edge.origin_vault_id) === owner.ownerId) {
      return sendJson(res, 400, {
        error: "give_is_receiver_owned",
        message:
          "this copy already belongs to its receiver and cannot be revoked",
        edge: closedEdgeDto(edge),
      });
    }

    // Neither side, or the id names nothing at all — identical trace.
    return sendJson(res, 404, { error: "not_found" });
  };
}
