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
 *
 * AND THE ACT IS BRACKETED BY AN ATTEMPT ROW (#1014, V3). The receipt is
 * written last, so it can only ever say "this completed". A placement is three
 * transactions over three databases — the origin's authority, the audience's
 * projection, and for a move the origin's release — and a crash between any
 * two of them used to leave the gateway with NOTHING recorded, so a retry of
 * the same token was indistinguishable from a fresh placement. The order is
 * now: record the attempt with its parameters, do the three steps (each
 * idempotent by id), write the receipt, drop the attempt. A retry resumes; a
 * retry that re-addresses the placement is refused.
 */

import type { IncomingMessage } from "node:http";

import { ROUTES } from "@centraid/core/protocol";
import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import {
  isShareableItemType,
  moveItemsOutOfVault,
  placeItemsInVault,
} from "@centraid/vault";
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
import {
  beginSharePlacementAttempt,
  finishSharePlacementAttempt,
  readSharePlacementAttempt,
  sameSharePlacement,
} from "../serve/share-placement-attempts.js";
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
  /** The origin's release for a move — injected so a suite can kill it. */
  release?: typeof moveItemsOutOfVault;
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
    //
    // UNLESS THE ACT IS STILL UNFINISHED (#1014, V3). A receipt with an
    // attempt row still beside it is a move whose origin release did not land:
    // answering "completed" here would leave the item in both vaults forever,
    // because nothing else ever revisits a receipted placement.
    const already = readShareAccessReceipt(
      deps.gatewayDatabase,
      input.placementId
    );
    if (
      already &&
      !readSharePlacementAttempt(deps.gatewayDatabase, input.placementId)
    )
      return sendJson(res, 200, placementWire(already));

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

    // RECORDED BEFORE THE FIRST VAULT WRITE (#1014, V3). The receipt below is
    // written LAST and means "completed"; nothing meant "began", so a crash
    // between the three transactions left no record at all and the phone's
    // retry could not be told from a fresh act.
    const act = {
      placementId: input.placementId,
      ownerId: owner.ownerId,
      kind: input.kind,
      itemType: input.itemType,
      originVaultId: input.originVaultId,
      audienceVaultId: input.audienceVaultId,
      originItemIds: input.itemIds,
    };
    const held = readSharePlacementAttempt(
      deps.gatewayDatabase,
      input.placementId
    );
    // ONE TOKEN IS ONE ACT. A retry that re-addresses a placement in flight is
    // a different placement wearing the same id, and performing it would place
    // items nobody asked to place under a token the caller believes settled.
    if (held && !sameSharePlacement(held, act))
      return sendJson(res, 409, {
        error: "placement_id_reused",
        message:
          "this placement id is already in flight for a different placement",
      });
    beginSharePlacementAttempt(deps.gatewayDatabase, act);

    let recorded = readShareAccessReceipt(
      deps.gatewayDatabase,
      input.placementId
    );
    if (!recorded) {
      let targetItemIds: string[];
      try {
        // GRANT AND PROJECT ONLY — `kind: "add"` however this placement is
        // addressed (#1014, V3). The origin's release moves BELOW the receipt.
        targetItemIds = (deps.place ?? placeItemsInVault)({
          kind: "add",
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
      recorded = readShareAccessReceipt(
        deps.gatewayDatabase,
        input.placementId
      );
    }
    // THE ORIGIN'S RELEASE IS LAST, AFTER THE RECEIPT (#1014, V3).
    //
    // It used to run inside `placeItemsInVault`, BEFORE the receipt — so a
    // move killed between the two left the origin empty and the gateway with
    // no record, and the retry could not even re-read the closure it needed:
    // `readShareClosure` refused the items the first attempt had already
    // removed, and the phone's outbox retried a `placement_failed` forever.
    // Released after the receipt, the crash window leaves the item in BOTH
    // vaults — recoverable, because the retry finds the receipt, skips the
    // projection and releases. The attempt row is what keeps that retry
    // coming: it survives until the release does.
    if (input.kind === "move") {
      try {
        (deps.release ?? moveItemsOutOfVault)({
          source: origin,
          itemType: input.itemType,
          itemIds: input.itemIds,
        });
      } catch (error) {
        return sendJson(res, 502, {
          error: "placement_release_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // ONLY NOW. The attempt row is the evidence that this act is unfinished;
    // it goes once every step it brackets is durable.
    finishSharePlacementAttempt(deps.gatewayDatabase, input.placementId);
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
