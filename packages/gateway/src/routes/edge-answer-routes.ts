/*
 * D9's answer route (#726 P3 decision 9): `GET /centraid/_gateway/edges/pending`
 * lists what is parked awaiting THIS owner's decision, and
 * `POST /centraid/_gateway/edges/:edgeId/answer` decides it. Accepting PULLS
 * the closure fresh from the origin (`peer-edge-give-client.ts`'s
 * `pullEdgeClosure`) rather than projecting anything staged earlier —
 * nothing was staged (`peer-edge-give-route.ts`'s 'ask' branch writes only a
 * pointer row). Refusing writes nothing back to the origin at all: D9 says a
 * refusal reaches forward only, and there is no route by which an answer
 * here could tell the sender anything more than what the original 'ask'
 * already didn't.
 *
 * The answering UI itself is P6; this is the state machinery and the route.
 */

import type { IncomingMessage } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import type { ShareVaultRef } from "@centraid/vault";
import { projectShareClosure } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import { recordPendingPulls } from "../serve/peer-blob-pull.js";
import {
  isWireClosureShape,
  verifyDerivatives,
  writeDerivativeBytes,
} from "../serve/peer-closure-blobs.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import { pullEdgeClosure } from "../serve/peer-edge-give-client.js";
import { recordPendingRefusal } from "../serve/peer-refusal-relay.js";
import { peerViewOf } from "../serve/vault-link-row.js";
import type { VaultLinksStore } from "../serve/vault-links-store.js";
import { readJson, sendJson } from "./route-helpers.js";

const EDGES_PREFIX = "/centraid/_gateway/edges";

export interface EdgeAnswerRouteDeps {
  gatewayDatabase: GatewayDatabase;
  enrollments: EnrollmentStore;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  peerDial?: PeerDial;
}

interface PendingGiveRow {
  edge_id: string;
  link_id: string;
  peer_vault_id: string;
  local_vault_id: string;
  item_type: string;
  item_count: number;
  created_at: string;
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pendingDto(row: PendingGiveRow): Record<string, unknown> {
  return {
    edgeId: row.edge_id,
    peerVaultId: row.peer_vault_id,
    localVaultId: row.local_vault_id,
    itemType: row.item_type,
    itemCount: row.item_count,
    createdAt: row.created_at,
  };
}

export function makeEdgeAnswerRouteHandler(
  deps: EdgeAnswerRouteDeps
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (!url.pathname.startsWith(EDGES_PREFIX)) return false;
    const deviceId = callerDeviceId(req);
    const owner = deviceId ? deps.enrollments.ownerFor(deviceId) : undefined;
    if (!deviceId || !owner)
      return sendJson(res, 403, { error: "device_identity_required" });
    const owners = deps.enrollments.owners;

    if (url.pathname === `${EDGES_PREFIX}/pending`) {
      if ((req.method ?? "GET") !== "GET") return false;
      const rows = deps.gatewayDatabase.db
        .prepare("SELECT * FROM peer_pending_gives ORDER BY created_at")
        .all() as unknown as PendingGiveRow[];
      const mine = rows.filter(
        (row) => owners.ownerOf(row.local_vault_id) === owner.ownerId
      );
      return sendJson(res, 200, { pending: mine.map(pendingDto) });
    }

    const rest = url.pathname.slice(`${EDGES_PREFIX}/`.length).split("/");
    if (rest.length !== 2 || rest[1] !== "answer") return false;
    if ((req.method ?? "GET") !== "POST")
      return sendJson(res, 405, { error: "method_not_allowed" });
    const edgeId = decodeURIComponent(rest[0] ?? "");
    const row = deps.gatewayDatabase.db
      .prepare("SELECT * FROM peer_pending_gives WHERE edge_id = ?")
      .get(edgeId) as PendingGiveRow | undefined;
    // An edge the caller cannot see at all, and one this owner does not
    // control, look identical — topology hiding, same as the edge plane.
    if (!row || owners.ownerOf(row.local_vault_id) !== owner.ownerId) {
      return sendJson(res, 404, { error: "not_found" });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: "invalid_body" });
    }
    if (body.decision !== "accept" && body.decision !== "refuse") {
      return sendJson(res, 400, {
        error: "invalid_decision",
        message: "decision must be accept or refuse",
      });
    }
    if (body.decision === "refuse") {
      // The answer is durable the instant this transaction commits — before
      // any network attempt. Delivery to the origin (so its edge lands
      // `denied` instead of `parked` forever, #726 P3 decision 9) happens on
      // the next `drainPeerRefusals` scheduler tick, never on this request:
      // an offline origin must never block the owner's answer.
      deps.gatewayDatabase.transaction(() => {
        deps.gatewayDatabase.run(
          "DELETE FROM peer_pending_gives WHERE edge_id = ?",
          edgeId
        );
        recordPendingRefusal(deps.gatewayDatabase, {
          edgeId,
          linkId: row.link_id,
          peerVaultId: row.peer_vault_id,
          localVaultId: row.local_vault_id,
        });
      });
      return sendJson(res, 200, { edgeId, decision: "refuse" });
    }

    const link = deps.links.get(row.link_id);
    const view = link ? peerViewOf(link, row.local_vault_id) : undefined;
    if (!view || !deps.peerDial) {
      return sendJson(res, 409, {
        error: "peer_unreachable",
        message: "no route to the origin right now — try again later",
      });
    }
    const audience = deps.vaultFor(row.local_vault_id);
    if (!audience) return sendJson(res, 404, { error: "not_found" });
    const pulled = await pullEdgeClosure({
      dial: deps.peerDial,
      route: view.route,
      edgeId,
    });
    if (pulled.state !== "given") {
      return sendJson(res, 409, {
        error: "peer_unreachable",
        message:
          pulled.state === "unreachable" || pulled.state === "not_found"
            ? "no route to the origin right now — try again later"
            : "the origin's answer could not be used",
      });
    }
    if (
      !isWireClosureShape(pulled.closure) ||
      pulled.closure.originVaultId !== row.peer_vault_id
    ) {
      return sendJson(res, 409, {
        error: "peer_unreachable",
        message: "malformed origin answer",
      });
    }
    const mismatch = verifyDerivatives(pulled.closure, pulled.derivatives);
    if (mismatch) {
      return sendJson(res, 409, {
        error: "peer_unreachable",
        message: mismatch,
      });
    }
    let project;
    try {
      writeDerivativeBytes(audience, pulled.derivatives);
      project = projectShareClosure(audience.vault, pulled.closure, {
        sharedBy: `peer:${pulled.closure.originVaultId}`,
      });
    } catch (error) {
      return sendJson(res, 409, {
        error: "peer_unreachable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    deps.gatewayDatabase.run(
      "DELETE FROM peer_pending_gives WHERE edge_id = ?",
      edgeId
    );
    recordPendingPulls(deps.gatewayDatabase, audience, {
      edgeId,
      linkId: row.link_id,
      localVaultId: row.local_vault_id,
      originals: pulled.closure.blobs.filter(
        (entry) => entry.rung === "original"
      ),
    });
    return sendJson(res, 200, {
      edgeId,
      decision: "accept",
      items: project.items,
    });
  };
}
