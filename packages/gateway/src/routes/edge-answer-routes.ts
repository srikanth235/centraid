/*
 * D9's answer route (#726 P3 decision 9): `GET /centraid/_gateway/edges/pending`
 * lists what is parked awaiting THIS owner's decision, and
 * `POST /centraid/_gateway/edges/:edgeId/answer` decides it.
 *
 * Both read the ONE share outbox since #750: a give the audience asked about
 * is an `await-answer` effect (`share_effects`), not a table of its own. That
 * effect deliberately carries no closure and no bytes — accepting PULLS the
 * closure fresh from the origin (`peer-edge-give-client.ts`'s
 * `pullEdgeClosure`) rather than projecting something staged earlier to go
 * stale.
 *
 * Refusing writes the origin's notification into the SAME outbox, in the same
 * transaction that closes the ask: the owner's answer is durable before any
 * network attempt, and delivery happens on a later sweep tick. An offline
 * origin can never block — or lose — a refusal.
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
import type { ShareEffect } from "../serve/share-coordinator.js";
import {
  completeShareEffect,
  enqueueShareEffect,
  findQueuedEffect,
  listQueuedEffects,
} from "../serve/share-effects.js";
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

type AwaitAnswer = Extract<ShareEffect, { kind: "await-answer" }>;

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pendingDto(
  effect: AwaitAnswer,
  createdAt: string
): Record<string, unknown> {
  return {
    edgeId: effect.edgeId,
    peerVaultId: effect.peerVaultId,
    localVaultId: effect.localVaultId,
    itemType: effect.itemType,
    itemCount: effect.itemCount,
    createdAt,
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
      const pending = listQueuedEffects(
        deps.gatewayDatabase,
        "await-answer"
      ).flatMap((row) =>
        row.effect.kind === "await-answer" &&
        owners.ownerOf(row.effect.localVaultId) === owner.ownerId
          ? [
              pendingDto(
                row.effect,
                createdAtOf(deps.gatewayDatabase, row.effectId)
              ),
            ]
          : []
      );
      return sendJson(res, 200, { pending });
    }

    const rest = url.pathname.slice(`${EDGES_PREFIX}/`.length).split("/");
    if (rest.length !== 2 || rest[1] !== "answer") return false;
    if ((req.method ?? "GET") !== "POST")
      return sendJson(res, 405, { error: "method_not_allowed" });
    const edgeId = decodeURIComponent(rest[0] ?? "");
    const queued = findQueuedEffect(
      deps.gatewayDatabase,
      "await-answer",
      edgeId
    );
    const ask =
      queued?.effect.kind === "await-answer" ? queued.effect : undefined;
    // An edge the caller cannot see at all, and one this owner does not
    // control, look identical — topology hiding, same as the edge plane.
    if (!ask || !queued || owners.ownerOf(ask.localVaultId) !== owner.ownerId) {
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
      // a later sweep tick, never on this request: an offline origin must
      // never block the owner's answer.
      deps.gatewayDatabase.transaction(() => {
        completeShareEffect(deps.gatewayDatabase, queued.effectId);
        enqueueShareEffect(deps.gatewayDatabase, {
          kind: "deliver-refusal",
          edgeId,
          linkId: ask.linkId,
          peerVaultId: ask.peerVaultId,
          localVaultId: ask.localVaultId,
        });
      });
      return sendJson(res, 200, { edgeId, decision: "refuse" });
    }

    const view = deps.links.peerViewFor(ask.linkId, ask.localVaultId);
    if (!view || !deps.peerDial) {
      return sendJson(res, 409, {
        error: "peer_unreachable",
        message: "no route to the origin right now — try again later",
      });
    }
    const audience = deps.vaultFor(ask.localVaultId);
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
      pulled.closure.originVaultId !== ask.peerVaultId
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
    completeShareEffect(deps.gatewayDatabase, queued.effectId);
    recordPendingPulls(deps.gatewayDatabase, audience, {
      edgeId,
      linkId: ask.linkId,
      localVaultId: ask.localVaultId,
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

/** When the ask landed — the outbox row's own `created_at`, not a new clock. */
function createdAtOf(db: GatewayDatabase, effectId: string): string {
  const row = db.db
    .prepare("SELECT created_at FROM share_effects WHERE effect_id = ?")
    .get(effectId) as { created_at: string } | undefined;
  return row?.created_at ?? new Date().toISOString();
}
