import type { IncomingMessage } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { ROUTES } from "@centraid/protocol";
import {
  isShareableItemType,
  moveOutOfVault,
  shareToVault,
} from "@centraid/vault";
import type { ShareVaultRef, ShareableItemType } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import { canWrite } from "../serve/enrollment-store.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import { recordShareAccessReceipt } from "../serve/share-access-receipts.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PLACEMENTS_PATH = ROUTES.gatewayPlacements;

type PlacementKind = "add" | "move";
type PlacementStatus =
  | "queued"
  | "in-flight"
  | "executed"
  | "parked"
  | "denied"
  | "failed";

interface PlacementInput {
  linkToken: string;
  kind: PlacementKind;
  itemType: ShareableItemType;
  itemId: string;
  sourceVaultId: string;
  targetVaultId: string;
}

interface PlacementRow {
  link_token: string;
  device_id: string;
  member_id: string;
  kind: PlacementKind;
  item_type: ShareableItemType;
  item_id: string;
  source_vault_id: string;
  target_vault_id: string;
  target_item_id: string | null;
  target_state: "queued" | "executed";
  source_state: "not-needed" | "queued" | "executed";
  status: PlacementStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlacementRouteDeps {
  gatewayDatabase: GatewayDatabase;
  enrollments: EnrollmentStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  share?: typeof shareToVault;
  move?: typeof moveOutOfVault;
}

/**
 * Durable reconciler for Add to / Move to. A crash can land between the two
 * vault commits, but can never remove the source first: target_state is the
 * idempotent receipt replay consults before the source step.
 */
export function makePlacementRouteHandler(
  deps: PlacementRouteDeps
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== PLACEMENTS_PATH) return false;
    const deviceId = callerDeviceId(req);
    const member = deviceId ? deps.enrollments.memberFor(deviceId) : undefined;
    if (!deviceId || !member)
      return sendJson(res, 403, { error: "device_identity_required" });

    if ((req.method ?? "GET") === "GET") {
      const rows = deps.gatewayDatabase.db
        .prepare(
          `SELECT * FROM placement_intents
            WHERE device_id = ?
            ORDER BY updated_at DESC LIMIT 200`
        )
        .all(deviceId) as unknown as PlacementRow[];
      return sendJson(res, 200, {
        placements: rows.map((row) =>
          placementWire(row, receiptFor(deps.gatewayDatabase, row.link_token))
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
        error: "invalid_placement",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const sourceRole = deps.enrollments.members.roleIn(
      member.memberId,
      input.sourceVaultId
    );
    const targetRole = deps.enrollments.members.roleIn(
      member.memberId,
      input.targetVaultId
    );
    if (!sourceRole || !targetRole)
      return sendJson(res, 404, { error: "not_found" });
    if (
      !canWrite(targetRole) ||
      (input.kind === "move" && !canWrite(sourceRole))
    )
      return sendJson(res, 403, {
        error: "forbidden",
        message:
          input.kind === "move"
            ? "moving needs write access in both source and target"
            : "adding needs write access in the target",
      });
    const source = deps.vaultFor(input.sourceVaultId);
    const target = deps.vaultFor(input.targetVaultId);
    if (!source || !target) return sendJson(res, 404, { error: "not_found" });

    let row: PlacementRow;
    try {
      row = insertOrRead(
        deps.gatewayDatabase,
        deviceId,
        member.memberId,
        input
      );
    } catch (error) {
      return sendJson(res, 409, {
        error: "placement_token_collision",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      row = reconcile(
        deps.gatewayDatabase,
        row,
        source,
        target,
        deps.share ?? shareToVault,
        deps.move ?? moveOutOfVault
      );
      return sendJson(
        res,
        200,
        placementWire(row, receiptFor(deps.gatewayDatabase, row.link_token))
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.gatewayDatabase.run(
        `UPDATE placement_intents
            SET status = 'parked', reason = ?, updated_at = ?
          WHERE link_token = ?`,
        reason,
        new Date().toISOString(),
        input.linkToken
      );
      row = readRow(deps.gatewayDatabase, input.linkToken)!;
      return sendJson(
        res,
        202,
        placementWire(row, receiptFor(deps.gatewayDatabase, row.link_token))
      );
    }
  };
}

function reconcile(
  db: GatewayDatabase,
  row: PlacementRow,
  source: ShareVaultRef,
  target: ShareVaultRef,
  share: typeof shareToVault,
  move: typeof moveOutOfVault
): PlacementRow {
  if (row.status === "executed") return row;
  let current = row;
  update(db, current.link_token, "in-flight", null);
  if (current.target_state !== "executed") {
    const result = share({
      origin: source,
      originVaultId: current.source_vault_id,
      audience: target,
      itemType: current.item_type,
      itemId: current.item_id,
      sharedByMember: current.member_id,
    });
    db.transaction(() => {
      db.run(
        `UPDATE placement_intents
            SET target_state = 'executed', target_item_id = ?, updated_at = ?
          WHERE link_token = ?`,
        result.itemId,
        new Date().toISOString(),
        current.link_token
      );
      recordShareAccessReceipt(db, {
        linkToken: current.link_token,
        memberId: current.member_id,
        action: "share",
        itemType: current.item_type,
        originVaultId: current.source_vault_id,
        originItemId: current.item_id,
        audienceVaultId: current.target_vault_id,
        audienceItemId: result.itemId,
      });
    });
  }
  current = readRow(db, current.link_token)!;
  if (current.kind === "move" && current.source_state !== "executed") {
    move({
      source,
      itemType: current.item_type,
      itemId: current.item_id,
    });
    db.run(
      `UPDATE placement_intents
          SET source_state = 'executed', updated_at = ?
        WHERE link_token = ?`,
      new Date().toISOString(),
      current.link_token
    );
  }
  update(db, current.link_token, "executed", null);
  return readRow(db, current.link_token)!;
}

function insertOrRead(
  db: GatewayDatabase,
  deviceId: string,
  memberId: string,
  input: PlacementInput
): PlacementRow {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO placement_intents
       (link_token, device_id, member_id, kind, item_type, item_id,
        source_vault_id, target_vault_id, target_state, source_state,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'queued', ?, ?)
     ON CONFLICT(link_token) DO NOTHING`,
    input.linkToken,
    deviceId,
    memberId,
    input.kind,
    input.itemType,
    input.itemId,
    input.sourceVaultId,
    input.targetVaultId,
    input.kind === "move" ? "queued" : "not-needed",
    now,
    now
  );
  const row = readRow(db, input.linkToken)!;
  const same =
    row.device_id === deviceId &&
    row.member_id === memberId &&
    row.kind === input.kind &&
    row.item_type === input.itemType &&
    row.item_id === input.itemId &&
    row.source_vault_id === input.sourceVaultId &&
    row.target_vault_id === input.targetVaultId;
  if (!same) throw new Error("linkToken already names another placement");
  return row;
}

function readRow(
  db: GatewayDatabase,
  linkToken: string
): PlacementRow | undefined {
  return db.db
    .prepare("SELECT * FROM placement_intents WHERE link_token = ?")
    .get(linkToken) as PlacementRow | undefined;
}

function update(
  db: GatewayDatabase,
  linkToken: string,
  status: PlacementStatus,
  reason: string | null
): void {
  db.run(
    `UPDATE placement_intents SET status = ?, reason = ?, updated_at = ?
      WHERE link_token = ?`,
    status,
    reason,
    new Date().toISOString(),
    linkToken
  );
}

function placementWire(
  row: PlacementRow,
  accessReceiptId?: string
): Record<string, unknown> {
  return {
    linkToken: row.link_token,
    kind: row.kind,
    itemType: row.item_type,
    itemId: row.item_id,
    sourceVaultId: row.source_vault_id,
    targetVaultId: row.target_vault_id,
    ...(row.target_item_id ? { targetItemId: row.target_item_id } : {}),
    targetState: row.target_state,
    sourceState: row.source_state,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(accessReceiptId ? { accessReceiptId } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function receiptFor(
  db: GatewayDatabase,
  linkToken: string
): string | undefined {
  return (
    db.db
      .prepare(
        "SELECT receipt_id FROM share_access_receipts WHERE link_token = ?"
      )
      .get(linkToken) as { receipt_id: string } | undefined
  )?.receipt_id;
}

function parseInput(body: Record<string, unknown>): PlacementInput {
  const string = (key: string): string => {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 512)
      throw new Error(`${key} must be a non-empty string`);
    return value;
  };
  const kind = string("kind");
  if (kind !== "add" && kind !== "move")
    throw new Error("kind must be add or move");
  const itemType = string("itemType");
  if (!isShareableItemType(itemType))
    throw new Error(`${itemType} is not placeable`);
  const sourceVaultId = string("sourceVaultId");
  const targetVaultId = string("targetVaultId");
  if (sourceVaultId === targetVaultId)
    throw new Error("source and target vaults must differ");
  return {
    linkToken: string("linkToken"),
    kind,
    itemType,
    itemId: string("itemId"),
    sourceVaultId,
    targetVaultId,
  };
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
