// WHAT A PLACEMENT THAT STARTED LEAVES BEHIND (#1014, V3).
//
// `share_access_receipts` is written LAST and means "this act completed".
// Nothing meant "this act began" — and a placement is three transactions over
// three databases (the origin's authority, the audience's projection, and for
// a move the origin's release), so a crash between any two of them left the
// gateway with no record at all. The phone's outbox then retried the same
// placement token and the route could not tell a RESUME from a fresh act.
//
// TWO THINGS THIS ROW BUYS, AND NEITHER IS ORDERING FOR ITS OWN SAKE:
//
//   - ONE TOKEN IS ONE ACT. The attempt carries the act's parameters, so a
//     retry that arrives under the same `placementId` with different items or
//     a different pair is REFUSED rather than performed. Without it, a client
//     bug or a replayed body could re-address a placement mid-flight.
//   - A STUCK PLACEMENT IS VISIBLE. `attempts` counts the resumes, so a
//     placement that never completes is a row an operator can find instead of
//     silence on both sides.
//
// The vault steps are each idempotent by id — `INSERT OR IGNORE` on the
// authority (its live-answer unique index), dedupe-by-content on the
// projection, and a delete for the move — so a resume converges rather than
// doubling. This row is what makes the resume RECOGNISED, not what makes it
// safe.

import type { GatewayDatabase } from "./gateway-db.js";

/** How long an attempt nobody finished is kept before the next one drops it. */
export const PLACEMENT_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SharePlacementAttempt {
  placementId: string;
  ownerId: string;
  kind: "add" | "move";
  itemType: string;
  originVaultId: string;
  audienceVaultId: string;
  originItemIds: string[];
  startedAt: string;
  attempts: number;
}

interface RawAttempt {
  placement_id: string;
  owner_id: string;
  kind: string;
  item_type: string;
  origin_vault_id: string;
  audience_vault_id: string;
  origin_item_ids_json: string;
  started_at: string;
  attempts: number;
}

function toAttempt(raw: RawAttempt): SharePlacementAttempt {
  const parsed: unknown = JSON.parse(raw.origin_item_ids_json);
  return {
    placementId: raw.placement_id,
    ownerId: raw.owner_id,
    kind: raw.kind as "add" | "move",
    itemType: raw.item_type,
    originVaultId: raw.origin_vault_id,
    audienceVaultId: raw.audience_vault_id,
    originItemIds: Array.isArray(parsed) ? (parsed as string[]) : [],
    startedAt: raw.started_at,
    attempts: raw.attempts,
  };
}

export function readSharePlacementAttempt(
  database: GatewayDatabase,
  placementId: string
): SharePlacementAttempt | undefined {
  const raw = database.db
    .prepare(
      `SELECT placement_id, owner_id, kind, item_type, origin_vault_id,
              audience_vault_id, origin_item_ids_json, started_at, attempts
         FROM share_placement_attempts WHERE placement_id = ?`
    )
    .get(placementId) as RawAttempt | undefined;
  return raw ? toAttempt(raw) : undefined;
}

/** True when a retry under this token is asking for the SAME act. */
export function sameSharePlacement(
  held: SharePlacementAttempt,
  input: Omit<SharePlacementAttempt, "startedAt" | "attempts">
): boolean {
  return (
    held.ownerId === input.ownerId &&
    held.kind === input.kind &&
    held.itemType === input.itemType &&
    held.originVaultId === input.originVaultId &&
    held.audienceVaultId === input.audienceVaultId &&
    held.originItemIds.length === input.originItemIds.length &&
    held.originItemIds.every((id, at) => id === input.originItemIds[at])
  );
}

/**
 * Record that this placement began, or count one more attempt at it.
 *
 * Written BEFORE the first vault write, which is the whole point: an attempt
 * recorded after the work it describes would leave the same window the receipt
 * already leaves.
 */
export function beginSharePlacementAttempt(
  database: GatewayDatabase,
  input: Omit<SharePlacementAttempt, "startedAt" | "attempts">,
  now = new Date()
): SharePlacementAttempt {
  // BOUNDED HERE, BY THE NEXT PLACEMENT. An attempt nobody ever finished — a
  // phone that gave up, an owner who uninstalled — would otherwise sit forever;
  // this table has no sweep of its own and does not deserve one.
  database.run(
    `DELETE FROM share_placement_attempts WHERE started_at < ?`,
    new Date(now.getTime() - PLACEMENT_ATTEMPT_TTL_MS).toISOString()
  );
  database.run(
    `INSERT INTO share_placement_attempts
       (placement_id, owner_id, kind, item_type, origin_vault_id,
        audience_vault_id, origin_item_ids_json, started_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (placement_id) DO UPDATE SET attempts = attempts + 1`,
    input.placementId,
    input.ownerId,
    input.kind,
    input.itemType,
    input.originVaultId,
    input.audienceVaultId,
    JSON.stringify(input.originItemIds),
    now.toISOString()
  );
  return readSharePlacementAttempt(database, input.placementId)!;
}

/** The placement completed; the receipt is the durable record from here. */
export function finishSharePlacementAttempt(
  database: GatewayDatabase,
  placementId: string
): void {
  database.run(
    `DELETE FROM share_placement_attempts WHERE placement_id = ?`,
    placementId
  );
}
