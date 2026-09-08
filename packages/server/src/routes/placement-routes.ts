/*
 * `POST /centraid/_gateway/edges` — SAME-OWNER PLACEMENT between two of the
 * owner's own vaults (#726 P2, same-owner only since #825 ruling G-copy;
 * reduced to one call by #928 A7).
 *
 * There is no edge row, no effect outbox, no reducer and no retry sweep any
 * more. A placement is not a distributed obligation: both vaults are open in
 * this process, so the route makes ONE vault call — project into the
 * destination, then release the source for a move — and answers with what
 * happened. Durability of the INTENT belongs to the caller that owns the
 * offline queue (the phone's placement outbox), which is where it already was.
 *
 * `share_access_receipts` stays as HISTORY, and its UNIQUE `edge_id` is what
 * makes a replayed placement token exactly-once at this boundary. Whether a
 * pair may be crossed is decided ONLY by `serve/link-crossing.ts` (D3);
 * unauthorized pairs answer `not_found` — topology hiding.
 */

import type { IncomingMessage } from "node:http";

import { ROUTES } from "@centraid/core/protocol";
import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { isShareableItemType, placeItemsInVault } from "@centraid/vault";
import type { ShareVaultRef, ShareableItemType } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import { judgeEdgeCrossing } from "../serve/link-crossing.js";
import {
  listShareAccessReceipts,
  readShareAccessReceipt,
  recordShareAccessReceipt,
} from "../serve/share-access-receipts.js";
import type { ShareAccessReceiptRow } from "../serve/share-access-receipts.js";
import { validateItemIds } from "../serve/share-scope.js";
import type { VaultLinksStore } from "../serve/vault-links-store.js";
import { readJson, sendJson } from "./route-helpers.js";

export const EDGES_PATH = ROUTES.gatewayEdges;

export type PlacementKind = "add" | "move";

interface PlacementInput {
  placementId: string;
  originVaultId: string;
  audienceVaultId: string;
  kind: PlacementKind;
  itemType: ShareableItemType;
  /** Snapshot only: the fixed set of items the placement carries. */
  itemIds: string[];
}

export interface PlacementRouteDeps {
  gatewayDatabase: GatewayDatabase;
  enrollments: EnrollmentStore;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  /** The vault's own party — the principal a placement runs as (#916). */
  partyIdFor: (vaultId: string) => string | undefined;
  place?: typeof placeItemsInVault;
}

export function makePlacementRouteHandler(
  deps: PlacementRouteDeps
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== EDGES_PATH) return false;
    const deviceId = callerDeviceId(req);
    const owner = deviceId ? deps.enrollments.ownerFor(deviceId) : undefined;
    if (!deviceId || !owner)
      return sendJson(res, 403, { error: "device_identity_required" });

    if ((req.method ?? "GET") === "GET") {
      // Listing is BY OWNER (#750): every device of one owner sees the same
      // history, because the authority is the owner's.
      return sendJson(res, 200, {
        edges: listShareAccessReceipts(deps.gatewayDatabase, owner.ownerId).map(
          placementWire
        ),
      });
    }
    if ((req.method ?? "GET") !== "POST")
      return sendJson(res, 405, { error: "method_not_allowed" });

    let input: PlacementInput;
    try {
      input = parseInput(await readJson(req));
    } catch (error) {
      return sendJson(res, 400, {
        error: "invalid_edge",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // A replayed token answers the recorded placement — the phone's outbox
    // retries, and a retry must not place twice.
    const already = readShareAccessReceipt(
      deps.gatewayDatabase,
      input.placementId
    );
    if (already) return sendJson(res, 200, placementWire(already));

    // The ACTING owner must own the origin — a placement only leaves a vault
    // you own; whether the PAIR may cross is `judgeEdgeCrossing`'s question.
    const owners = deps.enrollments.owners;
    if (owners.ownerOf(input.originVaultId) !== owner.ownerId)
      return sendJson(res, 404, { error: "not_found" });
    const crossing = judgeEdgeCrossing(
      { links: deps.links, ownerOf: (vaultId) => owners.ownerOf(vaultId) },
      input.originVaultId,
      input.audienceVaultId
    );
    // No link, no information: all three refusals leave the same trace.
    if (crossing.state === "not_found")
      return sendJson(res, 404, { error: "not_found" });
    // COPY-AS-SHARE RETIRED (#825, ruling G-copy): `linked` always means a
    // cross-owner pair, and a copy is no longer a verb — refused cleanly,
    // not hidden: the caller has an approved relationship with that vault.
    if (crossing.state === "linked")
      return sendJson(res, 400, {
        error: "cross_owner_give_retired",
        message:
          "giving a copy to another person's vault has been replaced by sharing — grant them the album, folder or document instead",
      });

    // Both vaults are on this machine by construction (#825).
    const origin = deps.vaultFor(input.originVaultId);
    const audience = deps.vaultFor(input.audienceVaultId);
    if (!origin || !audience)
      // 503, not 404: the pair is legitimate and the vault is simply not open
      // here yet. The caller's own outbox retries a 5xx.
      return sendJson(res, 503, {
        error: "vault_not_open",
        message: "a vault this placement crosses is not open on this gateway",
      });
    const audiencePartyId = deps.partyIdFor(input.audienceVaultId) ?? "";

    let targetItemIds: string[];
    try {
      targetItemIds = (deps.place ?? placeItemsInVault)({
        kind: input.kind,
        origin,
        originVaultId: input.originVaultId,
        audience,
        audiencePartyId,
        itemType: input.itemType,
        itemIds: input.itemIds,
        sharedBy: owner.ownerId,
      }).targetItemIds;
    } catch (error) {
      return sendJson(res, 502, {
        error: "placement_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    recordShareAccessReceipt(deps.gatewayDatabase, {
      edgeId: input.placementId,
      ownerId: owner.ownerId,
      action: "share",
      placementKind: input.kind,
      createdByDevice: deviceId,
      itemType: input.itemType,
      originVaultId: input.originVaultId,
      originItemIds: input.itemIds,
      audienceVaultId: input.audienceVaultId,
      audienceItemIds: targetItemIds,
    });
    const recorded = readShareAccessReceipt(
      deps.gatewayDatabase,
      input.placementId
    );
    return sendJson(res, 200, recorded ? placementWire(recorded) : {});
  };
}

/**
 * The wire shape the phone's outbox and the renderer already read. `status` is
 * always `completed`: a placement that did not complete leaves no history row,
 * and the caller learns that from the HTTP status instead.
 */
function placementWire(row: ShareAccessReceiptRow): Record<string, unknown> {
  return {
    edgeId: row.edgeId,
    kind: row.placementKind ?? "add",
    mode: "snapshot",
    itemType: row.itemType,
    itemIds: row.originItemIds,
    originVaultId: row.originVaultId,
    audienceVaultId: row.audienceVaultId,
    verbs: "read",
    /** Provenance (#750). */
    ...(row.createdByDevice ? { createdByDevice: row.createdByDevice } : {}),
    targetItemIds: row.audienceItemIds,
    status: "completed",
    accessReceiptId: row.receiptId,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  };
}

function parseInput(body: Record<string, unknown>): PlacementInput {
  const string = (key: string): string => {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 512)
      throw new Error(`${key} must be a non-empty string`);
    return value;
  };
  const mode = string("mode");
  if (mode !== "snapshot")
    throw new Error(
      "mode must be snapshot; live lending was removed in issue #731"
    );
  const kind = string("kind");
  if (kind !== "add" && kind !== "move")
    throw new Error("kind must be add or move");
  const itemType = string("itemType");
  if (!isShareableItemType(itemType))
    throw new Error(`${itemType} is not placeable`);
  const originVaultId = string("originVaultId");
  const audienceVaultId = string("audienceVaultId");
  if (originVaultId === audienceVaultId)
    throw new Error("origin and audience vaults must differ");
  const verbs = string("verbs");
  if (verbs !== "read") throw new Error("verbs must be read");
  return {
    placementId: string("edgeId"),
    originVaultId,
    audienceVaultId,
    kind,
    itemType,
    itemIds: validateItemIds(body.itemIds),
  };
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
