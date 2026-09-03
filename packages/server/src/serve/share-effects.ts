import type { GatewayDatabase } from "./gateway-db.js";
import { effectIdFor } from "./share-coordinator.js";
import type { ShareEffect } from "./share-coordinator.js";

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export interface ShareEffectRow {
  effect_id: string;
  edge_id: string;
  kind: string;
  payload_json: string;
  status: "queued" | "done";
  attempts: number;
  next_attempt_at: number | null;
  created_at: string;
  updated_at: string;
}

export interface PendingShareEffect {
  effectId: string;
  attempts: number;
  effect: ShareEffect;
}

export function parseShareEffectRow(
  row: ShareEffectRow
): ShareEffect | undefined {
  if (row.kind !== "deliver-give") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  if (body.delivery === "peer" || body.crossOwner === true) return undefined;
  const edgeId =
    typeof row.edge_id === "string" && row.edge_id.length > 0
      ? row.edge_id
      : undefined;
  if (!edgeId) return undefined;
  return { kind: "deliver-give", edgeId };
}

export function enqueueShareEffect(
  db: GatewayDatabase,
  effect: ShareEffect,
  options: { now?: number } = {}
): string {
  const effectId = effectIdFor(effect);
  const now = options.now ?? Date.now();
  const iso = new Date(now).toISOString();
  db.run(
    `INSERT INTO share_effects
       (effect_id, edge_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
     ON CONFLICT (effect_id) DO NOTHING`,
    effectId,
    effect.edgeId,
    effect.kind,
    "{}",
    now,
    iso,
    iso
  );
  return effectId;
}

export function claimDueShareEffects(
  db: GatewayDatabase,
  options: { limit?: number; now?: number } = {}
): PendingShareEffect[] {
  const now = options.now ?? Date.now();
  const rows = (options.limit === undefined
    ? db.db
        .prepare(
          `SELECT * FROM share_effects
              WHERE status = 'queued' AND next_attempt_at IS NOT NULL
                AND next_attempt_at <= ?
              ORDER BY created_at`
        )
        .all(now)
    : db.db
        .prepare(
          `SELECT * FROM share_effects
              WHERE status = 'queued' AND next_attempt_at IS NOT NULL
                AND next_attempt_at <= ?
              ORDER BY created_at LIMIT ?`
        )
        .all(now, options.limit)) as unknown as ShareEffectRow[];
  return rows.flatMap((row) => {
    const effect = parseShareEffectRow(row);
    return effect
      ? [{ effectId: row.effect_id, attempts: row.attempts, effect }]
      : [];
  });
}

export function completeShareEffect(
  db: GatewayDatabase,
  effectId: string
): void {
  db.run(
    "UPDATE share_effects SET status = 'done', updated_at = ? WHERE effect_id = ?",
    new Date().toISOString(),
    effectId
  );
}

export function deferShareEffect(
  db: GatewayDatabase,
  effectId: string,
  options: { attempts: number; now?: number }
): void {
  const now = options.now ?? Date.now();
  const attempts = options.attempts + 1;
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
  db.run(
    `UPDATE share_effects
        SET attempts = ?, next_attempt_at = ?, updated_at = ?
      WHERE effect_id = ?`,
    attempts,
    now + delay,
    new Date(now).toISOString(),
    effectId
  );
}
