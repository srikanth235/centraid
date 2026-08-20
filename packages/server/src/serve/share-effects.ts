/*
 * The durable half of the sharing plane's ONE effect outbox (issue #750
 * abstraction 2) — `share_effects` in `gateway.db`. Reads and writes only;
 * what an effect MEANS is `share-coordinator.ts`, and what running one DOES
 * is `share-effect-executor.ts`.
 *
 * Every payload that leaves this module has been parsed, never cast: a row
 * whose JSON drifted (a hand edit, a half-written generation) is refused as
 * `undefined` and skipped by the drainer rather than handed to a transport as
 * if it were well-formed.
 */

import type { GatewayDatabase } from "./gateway-db.js";
import { effectIdFor } from "./share-coordinator.js";
import type { ShareEffect } from "./share-coordinator.js";

/** First retry delay; doubles per attempt up to `MAX_BACKOFF_MS`. */
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

/** A queued effect with its attempt count — what the executor is handed. */
export interface PendingShareEffect {
  effectId: string;
  attempts: number;
  effect: ShareEffect;
}

/**
 * Total parser: a row becomes a typed effect or nothing at all. Deliberately
 * NOT a throw — one unreadable row must not stop the drainer from making
 * progress on every other obligation this gateway holds.
 *
 * A row naming a RETIRED transport parses to nothing (#825): the peer effect
 * kinds and the cross-owner/peer `deliver-give` payload have no handler any
 * more. `retireDeadShareEffects` (`share-effects-retire.ts`) removes such rows
 * on gateway open rather than leaving them to be skipped forever, so reaching
 * one here means a hand edit or a half-written generation, not an upgrade.
 */
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
  // A copy-as-share obligation, whatever else its payload says.
  if (body.delivery === "peer" || body.crossOwner === true) return undefined;
  const edgeId =
    typeof row.edge_id === "string" && row.edge_id.length > 0
      ? row.edge_id
      : undefined;
  if (!edgeId) return undefined;
  return { kind: "deliver-give", edgeId };
}

/**
 * Enqueue an obligation. The primary key is DERIVED from what the effect is
 * about, so re-enqueuing after a crash (or a second identical begin) lands on
 * the same row instead of duplicating work.
 */
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
    // Nothing beyond the kind and the edge is carried any more: the retired
    // peer obligations were the only effects with a payload of their own.
    "{}",
    now,
    iso,
    iso
  );
  return effectId;
}

/** Every effect due for a machine attempt now, oldest first. */
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

/** Discharged — forward-only, so the row stays as evidence it happened. */
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

/** Not yet — try again later, down an exponential backoff. */
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
