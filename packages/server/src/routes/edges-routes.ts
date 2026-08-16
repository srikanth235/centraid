/*
 * `POST /centraid/_gateway/edges` — the cross-vault share/move plane (#726
 * P2). Succeeds `placement_intents`/`/placements` outright (pre-1.0, no
 * dual write, no COMPAT shim): one edge covers a SET of items — three
 * photographs sharing one edge project through ONE reconcile pass — where
 * a placement covered exactly one.
 *
 * Same-owner edges (Work→Personal) and cross-owner edges (father→daughter)
 * ride the SAME substrate below. Whether a pair may be crossed at all is not
 * decided here: `serve/link-crossing.ts` is the one answerer, for a vault on
 * this machine and a vault across the world alike (D3). An unauthorized pair
 * answers `not_found` — topology hiding, you learn nothing about a vault you
 * cannot reach.
 *
 * Since #750 this route hand-writes no status at all. It records the edge,
 * asks the reducer to `begin` (which durably enqueues ONE `deliver-give`
 * effect), and runs that effect inline so the owner still gets the answer
 * synchronously. If the peer is unreachable the effect stays in the outbox
 * and the sweep retries it — the give is no longer lost to a bad moment.
 *
 * GET lists by OWNER, not by device (#750 abstraction 5): authority is the
 * owner's, so every device of one owner sees the same edges.
 * `createdByDevice` remains on the wire as provenance.
 *
 * The retired live/lend mode is intentionally not accepted here (#731).
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
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import { effectIdFor } from "../serve/share-coordinator.js";
import type { EdgeDelivery, ShareEffect } from "../serve/share-coordinator.js";
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
  share?: typeof shareItemsToVault;
  move?: typeof moveOutOfVault;
  /**
   * Outbound peer-plane dialing (#726 P3 decision 7). Absent means this
   * build cannot dial out at all — a route that needs one parks rather than
   * ever reaching for a client that isn't there (production wiring of a real
   * transport is a `packages/tunnel` concern, out of this package's scope;
   * tests inject the same in-process transport the link ceremony tests do).
   */
  peerDial?: PeerDial;
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
    // The ACTING owner must own the origin outright — an edge only ever
    // leaves a vault you own. That is a fact about the caller, not about the
    // pair, so it stays here; whether the PAIR may be crossed at all is the
    // one answerer's question (`judgeEdgeCrossing`), same for a vault on this
    // machine and a vault across the world.
    const owners = deps.enrollments.owners;
    if (owners.ownerOf(input.originVaultId) !== owner.ownerId)
      return sendJson(res, 404, { error: "not_found" });
    const crossing = judgeEdgeCrossing(
      { links: deps.links, ownerOf: (vaultId) => owners.ownerOf(vaultId) },
      input.originVaultId,
      input.audienceVaultId
    );
    // No link, no information: a stranger's vault id, an unapproved link, and
    // a revoked one all leave the same trace.
    if (crossing.state === "not_found")
      return sendJson(res, 404, { error: "not_found" });
    // A move both gives away AND erases the owner's own copy — coherent only
    // within one person's own vaults, which is why the table itself refuses
    // `kind = 'move'` outside `mode = 'snapshot'` combined with same-owner
    // intent. Refused cleanly here (not `not_found`): the caller already has
    // a legitimate, approved relationship with this vault, so there is
    // nothing to hide from them.
    if (crossing.state === "linked" && input.kind === "move")
      return sendJson(res, 400, {
        error: "cross_owner_move_refused",
        message: "a move can only happen between vaults the same owner holds",
      });

    // `route` present means `judgeEdgeCrossing` resolved the audience to a
    // vault elsewhere — the ONLY thing remoteness changes (D3). No route (or
    // same-owner) is the same-machine path, unchanged.
    const route = crossing.state === "linked" ? crossing.route : undefined;
    const origin = deps.vaultFor(input.originVaultId);
    const audience = route ? undefined : deps.vaultFor(input.audienceVaultId);
    if (!origin || (!route && !audience))
      return sendJson(res, 404, { error: "not_found" });

    let row: EdgeRow;
    try {
      row = insertOrRead(deps.gatewayDatabase, deviceId, owner.ownerId, input);
    } catch (error) {
      return sendJson(res, 409, {
        error: "edge_token_collision",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const delivery: EdgeDelivery = route ? "peer" : "local";
    const facts = edgeFactsOf(row, {
      delivery,
      // Same-owner needs no link row to reach `judgeEdgeCrossing`'s "linked"
      // state at all (D3) — reaching this branch as "linked" always means a
      // CROSS-owner pair (threat 8).
      crossOwner: crossing.state === "linked",
    });
    row = applyEdgeSignal(deps.gatewayDatabase, row, facts, { type: "begin" });
    const effect: ShareEffect = {
      kind: "deliver-give",
      edgeId: row.edge_id,
      delivery,
      crossOwner: facts.crossOwner,
    };
    const outcome = await runShareEffect(effectDeps(deps), effect);
    settle(
      deps.gatewayDatabase,
      { effectId: effectIdFor(effect), attempts: 0, effect },
      outcome
    );
    const settled = readEdgeRow(deps.gatewayDatabase, row.edge_id) ?? row;
    // 202 is "this gateway could not act" — a vault call that threw, or a
    // build with no way to dial out. A peer STATE (asked, denied, offline)
    // is a 200 answer about the edge, exactly as before.
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
    links: deps.links,
    vaultFor: deps.vaultFor,
    ...(deps.peerDial ? { dial: deps.peerDial } : {}),
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
  // The fixed item set a snapshot copies — validated on the way in, parsed
  // (never cast) on the way out (`serve/share-scope.ts`).
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
    /** Provenance: which device acted, now that listing is by owner (#750). */
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
    // The same total validator the stored scope is read back through — one
    // definition of "a scope", at the wire door and at the audit door alike.
    itemIds: validateItemIds(body.itemIds),
    verbs: "read",
  };
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
