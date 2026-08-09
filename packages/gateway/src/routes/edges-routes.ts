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
 * `mode: 'live'` (#726 P4) is the other kind of edge: not a copy but a WINDOW.
 * It carries `scopes` instead of `itemIds` — a live edge has no fixed item
 * set, because its contents are whatever its consent scope covers at read
 * time — and it settles on `established` rather than `completed`, since there
 * is nothing to finish.
 */

import type { IncomingMessage } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { ROUTES } from "@centraid/protocol";
import {
  isShareableItemType,
  moveOutOfVault,
  shareItemsToVault,
} from "@centraid/vault";
import type { ShareVaultRef, ShareableItemType } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { BorrowedDeps } from "../serve/lend-audience.js";
import type { LendScope } from "../serve/lend-grant.js";
import type { LeaseSigner } from "../serve/lend-lease.js";
import { searchReachFor } from "../serve/lend-search-reach.js";
import type { ScopeSearchReach } from "../serve/lend-search-reach.js";
import { judgeEdgeCrossing } from "../serve/link-crossing.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import type { VaultLinksStore } from "../serve/vault-links-store.js";
import { openLiveEdge } from "./edges-live.js";
import { reconcileRemoteEdge } from "./edges-reconcile-remote.js";
import type { EdgeKind, EdgeMode, EdgeRow } from "./edges-reconcile.js";
import { readEdgeRow, reconcileEdge } from "./edges-reconcile.js";
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
  /** Live only: the standing row/column restriction the window is cut to. */
  scopes: LendScope[];
  /** Snapshot edges are always 'read'; a live edge may carry 'read+act' (#726 P5). */
  verbs: "read" | "read+act";
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
  /**
   * `VaultRegistry.signAsVault` (#726 P4). A live edge's lease is signed by
   * the ORIGIN VAULT's own identity key; a build without a signer can create
   * snapshot edges but never lends — refused as a capability, typed.
   */
  signAsVault?: LeaseSigner;
  /** The borrowed slots, for a CO-HOSTED live edge whose audience is here. */
  borrowed?: BorrowedDeps;
  /** Base64 identity key of a local vault (P1). */
  vaultPublicKey?: (vaultId: string) => string | undefined;
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
            WHERE created_by_device = ?
            ORDER BY updated_at DESC LIMIT 200`
        )
        .all(deviceId) as unknown as EdgeRow[];
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
    // Lending needs a vault signature for the lease (#726 P4 D8). A build
    // wired without a signer refuses as a CAPABILITY, before any ownership
    // check — never by silently opening an unsigned window.
    if (input.mode === "live" && !deps.signAsVault) {
      return sendJson(res, 400, {
        error: "lending_unavailable",
        message: "this gateway cannot sign a lease for a live edge",
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
    try {
      if (input.mode === "live") {
        row = await openLiveEdge({
          db: deps.gatewayDatabase,
          row,
          origin,
          audienceLabel:
            deps.links.peerForVault(input.audienceVaultId)?.peerLabel ??
            input.audienceVaultId,
          scopes: input.scopes,
          verbs: input.verbs,
          signAsVault: deps.signAsVault!,
          ...(route ? { route } : {}),
          ...(deps.peerDial ? { peerDial: deps.peerDial } : {}),
          ...(deps.borrowed ? { borrowed: deps.borrowed } : {}),
          ...(deps.vaultPublicKey
            ? { vaultPublicKey: deps.vaultPublicKey }
            : {}),
        });
      } else if (route) {
        if (!deps.peerDial)
          throw new Error("this gateway cannot dial out to a peer");
        row = await reconcileRemoteEdge(
          deps.gatewayDatabase,
          row,
          origin,
          route,
          deps.peerDial
        );
      } else {
        row = reconcileEdge(
          deps.gatewayDatabase,
          row,
          origin,
          audience!,
          deps.share ?? shareItemsToVault,
          deps.move ?? moveOutOfVault,
          // Same-owner needs no row to reach `judgeEdgeCrossing`'s "linked"
          // state at all (D3) — reaching this branch as "linked" always means
          // a co-hosted CROSS-owner pair (threat 8).
          crossing.state === "linked"
        );
      }
      return sendJson(
        res,
        200,
        edgeWire(
          row,
          receiptFor(deps.gatewayDatabase, row.edge_id),
          // Visible at MASK-SELECTION time (#726 P4 D10) — the same response
          // that establishes the edge already names which of its own scopes
          // will refuse a full search, before anyone has run one.
          input.mode === "live"
            ? searchReachFor(origin.vault, input.scopes)
            : undefined
        )
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.gatewayDatabase.run(
        `UPDATE share_edges
            SET status = 'parked', reason = ?, updated_at = ?
          WHERE edge_id = ?`,
        reason,
        new Date().toISOString(),
        input.edgeId
      );
      row = readEdgeRow(deps.gatewayDatabase, input.edgeId)!;
      return sendJson(
        res,
        202,
        edgeWire(row, receiptFor(deps.gatewayDatabase, row.edge_id))
      );
    }
  };
}

function insertOrRead(
  db: GatewayDatabase,
  deviceId: string,
  ownerId: string,
  input: EdgeInput
): EdgeRow {
  const now = new Date().toISOString();
  // One column, two meanings by mode: the fixed item set a snapshot copies, or
  // the standing declaration a window is cut to.
  const scopeJson = JSON.stringify(
    input.mode === "live" ? input.scopes : input.itemIds
  );
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
  accessReceiptId?: string,
  searchReach?: ScopeSearchReach[]
): Record<string, unknown> {
  return {
    edgeId: row.edge_id,
    kind: row.kind,
    mode: row.mode,
    itemType: row.item_type,
    ...(row.mode === "live"
      ? { scopes: JSON.parse(row.scope_json ?? "[]") }
      : { itemIds: JSON.parse(row.scope_json ?? "[]") }),
    // #726 P4 item 7 (D10): present only for a live edge whose reach was
    // computable — a scope with `masksSearchableColumns: true` will REFUSE a
    // search over its excluded columns rather than silently under-searching.
    ...(searchReach && searchReach.length > 0 ? { searchReach } : {}),
    originVaultId: row.origin_vault_id,
    audienceVaultId: row.audience_vault_id,
    verbs: row.verbs,
    ...(row.target_item_ids_json
      ? { targetItemIds: JSON.parse(row.target_item_ids_json) }
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
  if (mode !== "snapshot" && mode !== "live")
    throw new Error("mode must be snapshot or live");
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
  if (verbs !== "read" && verbs !== "read+act")
    throw new Error("verbs must be read or read+act");
  // A live edge has no fixed item set — its contents are whatever its scope
  // covers at read time — so the two modes take DIFFERENT inputs and neither
  // accepts the other's.
  if (mode === "live") {
    if (kind !== "add") throw new Error("a live edge cannot be a move");
    return {
      edgeId: string("edgeId"),
      originVaultId,
      audienceVaultId,
      mode,
      kind,
      itemType,
      itemIds: [],
      scopes: parseScopes(body.scopes),
      verbs,
    };
  }
  // A snapshot copies bytes once; there is nothing left to act on afterward.
  if (verbs !== "read") throw new Error("a snapshot edge's verbs must be read");
  const rawItemIds = body.itemIds;
  if (!Array.isArray(rawItemIds) || rawItemIds.length === 0)
    throw new Error("itemIds must be a non-empty array");
  const itemIds = dedupe(
    rawItemIds.map((entry, index) => {
      if (typeof entry !== "string" || entry.length === 0)
        throw new Error(`itemIds[${index}] must be a non-empty string`);
      return entry;
    })
  );
  return {
    edgeId: string("edgeId"),
    originVaultId,
    audienceVaultId,
    mode,
    kind,
    itemType,
    itemIds,
    scopes: [],
    verbs,
  };
}

/**
 * The lend scope declaration. Deliberately the SAME shape
 * `consent_grant_scope` stores — a row filter and a field mask over a
 * schema/table — because the grant this becomes is an ordinary consent grant
 * and a translation layer would be a second vocabulary to keep honest.
 */
function parseScopes(raw: unknown): LendScope[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error("a live edge needs a non-empty scopes array");
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== "object")
      throw new Error(`scopes[${index}] must be an object`);
    const scope = entry as Record<string, unknown>;
    if (typeof scope.schema !== "string" || scope.schema.length === 0)
      throw new Error(`scopes[${index}].schema must be a non-empty string`);
    if (scope.table !== undefined && typeof scope.table !== "string")
      throw new Error(`scopes[${index}].table must be a string`);
    if (scope.rowFilter !== undefined && !Array.isArray(scope.rowFilter))
      throw new Error(`scopes[${index}].rowFilter must be an array`);
    if (
      scope.fieldMask !== undefined &&
      (!Array.isArray(scope.fieldMask) ||
        scope.fieldMask.some((column) => typeof column !== "string"))
    ) {
      throw new Error(`scopes[${index}].fieldMask must be a string array`);
    }
    return {
      schema: scope.schema,
      ...(typeof scope.table === "string" ? { table: scope.table } : {}),
      ...(scope.rowFilter
        ? { rowFilter: scope.rowFilter as LendScope["rowFilter"] }
        : {}),
      ...(scope.fieldMask ? { fieldMask: scope.fieldMask as string[] } : {}),
    };
  });
}

/** First-occurrence order preserved — `scope_json` is a SET, not a log. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
