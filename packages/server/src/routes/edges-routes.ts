/*
 * `POST /centraid/_gateway/edges` — cross-vault share/move plane (#726 P2).
 * Replaces `placement_intents`/`/placements` outright (pre-1.0): one edge
 * covers a SET of items through ONE reconcile pass. SAME-OWNER ONLY since
 * #825 (ruling G-copy) — copies to another person's vault are refused;
 * sharing is a standing grant on `/centraid/_vault/grants`. Whether a pair
 * may be crossed is decided ONLY by `serve/link-crossing.ts` (D3);
 * unauthorized pairs answer `not_found` — topology hiding. Since #750 the
 * route hand-writes no status (reducer `begin` enqueues ONE `deliver-give`
 * effect, run inline for a synchronous answer). GET lists by OWNER;
 * `createdByDevice` stays as provenance. Live/lend not accepted (#731).
 */

import type { IncomingMessage } from "node:http";

import { ROUTES } from "@centraid/core/protocol";
import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { isShareableItemType } from "@centraid/vault";
import type {
  moveOutOfVault,
  shareItemsToVault,
  ShareVaultRef,
  ShareableItemType,
} from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import { judgeEdgeCrossing } from "../serve/link-crossing.js";
import { effectIdFor } from "../serve/share-coordinator.js";
import type { ShareEffect } from "../serve/share-coordinator.js";
import type { EdgeKind, EdgeMode, EdgeRow } from "../serve/share-edge-row.js";
import { readEdgeRow } from "../serve/share-edge-row.js";
import { applyEdgeSignal, edgeFactsOf } from "../serve/share-edge-store.js";
import { runShareEffect, settle } from "../serve/share-effect-executor.js";
import {
  parseEdgeScope,
  parseTargetItemIds,
  validateItemIds,
} from "../serve/share-scope.js";
import type { VaultLinksStore } from "../serve/vault-links-store.js";
import { readJson, sendJson } from "./route-helpers.js";

export const EDGES_PATH = ROUTES.gatewayEdges;

interface EdgeInput {
  edgeId: string;
  originVaultId: string;
  audienceVaultId: string;
  mode: EdgeMode;
  kind: EdgeKind;
  itemType: ShareableItemType;
  /** Snapshot only: the fixed set of items the edge copies. */
  itemIds: string[];
  verbs: "read";
}

export interface EdgesRouteDeps {
  gatewayDatabase: GatewayDatabase;
  enrollments: EnrollmentStore;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  /** The vault's own party — the principal an edge placement runs as (#916). */
  partyIdFor: (vaultId: string) => string | undefined;
  share?: typeof shareItemsToVault;
  move?: typeof moveOutOfVault;
}

export function makeEdgesRouteHandler(deps: EdgesRouteDeps): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== EDGES_PATH) return false;
    const deviceId = callerDeviceId(req);
    const owner = deviceId ? deps.enrollments.ownerFor(deviceId) : undefined;
    if (!deviceId || !owner)
      return sendJson(res, 403, { error: "device_identity_required" });

    if ((req.method ?? "GET") === "GET") {
      const rows = deps.gatewayDatabase.db
        .prepare(
          `SELECT * FROM share_edges
            WHERE owner_id = ?
            ORDER BY updated_at DESC LIMIT 200`
        )
        .all(owner.ownerId) as unknown as EdgeRow[];
      return sendJson(res, 200, {
        edges: rows.map((row) =>
          edgeWire(row, receiptFor(deps.gatewayDatabase, row.edge_id))
        ),
      });
    }
    if ((req.method ?? "GET") !== "POST")
      return sendJson(res, 405, { error: "method_not_allowed" });

    let input: EdgeInput;
    try {
      input = parseInput(await readJson(req));
    } catch (error) {
      return sendJson(res, 400, {
        error: "invalid_edge",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // The ACTING owner must own the origin — an edge only leaves a vault you
    // own; whether the PAIR may cross is `judgeEdgeCrossing`'s question alone.
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
    if (!origin || !audience) return sendJson(res, 404, { error: "not_found" });

    let row: EdgeRow;
    try {
      row = insertOrRead(deps.gatewayDatabase, deviceId, owner.ownerId, input);
    } catch (error) {
      return sendJson(res, 409, {
        error: "edge_token_collision",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const facts = edgeFactsOf(row);
    row = applyEdgeSignal(deps.gatewayDatabase, row, facts, { type: "begin" });
    const effect: ShareEffect = { kind: "deliver-give", edgeId: row.edge_id };
    const outcome = runShareEffect(effectDeps(deps), effect);
    settle(
      deps.gatewayDatabase,
      { effectId: effectIdFor(effect), attempts: 0, effect },
      outcome
    );
    const settled = readEdgeRow(deps.gatewayDatabase, row.edge_id) ?? row;
    // 202 = this gateway could not act (vault call threw, vault not open here).
    return sendJson(
      res,
      outcome.state === "retry" && outcome.fault ? 202 : 200,
      edgeWire(settled, receiptFor(deps.gatewayDatabase, settled.edge_id))
    );
  };
}

function effectDeps(
  deps: EdgesRouteDeps
): Parameters<typeof runShareEffect>[0] {
  return {
    db: deps.gatewayDatabase,
    vaultFor: deps.vaultFor,
    partyIdFor: deps.partyIdFor,
    ...(deps.share ? { share: deps.share } : {}),
    ...(deps.move ? { move: deps.move } : {}),
  };
}

function insertOrRead(
  db: GatewayDatabase,
  deviceId: string,
  ownerId: string,
  input: EdgeInput
): EdgeRow {
  const now = new Date().toISOString();
  // Validated on the way in, parsed (never cast) on the way out
  // (`serve/share-scope.ts`).
  const scopeJson = JSON.stringify(input.itemIds);
  db.run(
    `INSERT INTO share_edges
       (edge_id, created_by_device, owner_id, kind, mode, item_type,
        scope_json, origin_vault_id, audience_vault_id, verbs,
        target_state, source_state, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'queued', ?, ?)
     ON CONFLICT(edge_id) DO NOTHING`,
    input.edgeId,
    deviceId,
    ownerId,
    input.kind,
    input.mode,
    input.itemType,
    scopeJson,
    input.originVaultId,
    input.audienceVaultId,
    input.verbs,
    input.kind === "move" ? "queued" : "not-needed",
    now,
    now
  );
  const row = readEdgeRow(db, input.edgeId)!;
  const same =
    row.created_by_device === deviceId &&
    row.owner_id === ownerId &&
    row.kind === input.kind &&
    row.mode === input.mode &&
    row.item_type === input.itemType &&
    row.scope_json === scopeJson &&
    row.origin_vault_id === input.originVaultId &&
    row.audience_vault_id === input.audienceVaultId &&
    row.verbs === input.verbs;
  if (!same) throw new Error("edgeId already names another edge");
  return row;
}

function edgeWire(
  row: EdgeRow,
  accessReceiptId?: string
): Record<string, unknown> {
  return {
    edgeId: row.edge_id,
    kind: row.kind,
    mode: row.mode,
    itemType: row.item_type,
    itemIds: parseEdgeScope(row.mode, row.scope_json).itemIds,
    originVaultId: row.origin_vault_id,
    audienceVaultId: row.audience_vault_id,
    verbs: row.verbs,
    /** Provenance (#750). */
    createdByDevice: row.created_by_device,
    ...(row.target_item_ids_json
      ? { targetItemIds: parseTargetItemIds(row.target_item_ids_json) }
      : {}),
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(accessReceiptId ? { accessReceiptId } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function receiptFor(db: GatewayDatabase, edgeId: string): string | undefined {
  return (
    db.db
      .prepare("SELECT receipt_id FROM share_access_receipts WHERE edge_id = ?")
      .get(edgeId) as { receipt_id: string } | undefined
  )?.receipt_id;
}

function parseInput(body: Record<string, unknown>): EdgeInput {
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
    edgeId: string("edgeId"),
    originVaultId,
    audienceVaultId,
    mode,
    kind,
    itemType,
    // Same total validator the stored scope is read back through.
    itemIds: validateItemIds(body.itemIds),
    verbs: "read",
  };
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
