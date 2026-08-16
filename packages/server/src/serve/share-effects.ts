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
import type { ShareEffect, ShareEffectKind } from "./share-coordinator.js";

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

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Total parser: a row becomes a typed effect or nothing at all. Deliberately
 * NOT a throw — one unreadable row must not stop the drainer from making
 * progress on every other obligation this gateway holds.
 */
export function parseShareEffectRow(
  row: ShareEffectRow
): ShareEffect | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  const edgeId = string(row.edge_id);
  if (!edgeId) return undefined;
  switch (row.kind) {
    case "deliver-give": {
      const delivery = body.delivery;
      if (delivery !== "local" && delivery !== "peer") return undefined;
      return {
        kind: "deliver-give",
        edgeId,
        delivery,
        crossOwner: body.crossOwner === true,
      };
    }
    case "await-answer": {
      const linkId = string(body.linkId);
      const peerVaultId = string(body.peerVaultId);
      const localVaultId = string(body.localVaultId);
      const itemType = string(body.itemType);
      const itemCount = body.itemCount;
      if (
        !linkId ||
        !peerVaultId ||
        !localVaultId ||
        !itemType ||
        typeof itemCount !== "number"
      )
        return undefined;
      return {
        kind: "await-answer",
        edgeId,
        linkId,
        peerVaultId,
        localVaultId,
        itemType,
        itemCount,
      };
    }
    case "deliver-refusal": {
      const linkId = string(body.linkId);
      const peerVaultId = string(body.peerVaultId);
      const localVaultId = string(body.localVaultId);
      if (!linkId || !peerVaultId || !localVaultId) return undefined;
      return {
        kind: "deliver-refusal",
        edgeId,
        linkId,
        peerVaultId,
        localVaultId,
      };
    }
    case "pull-blob": {
      const linkId = string(body.linkId);
      const localVaultId = string(body.localVaultId);
      const sha256 = string(body.sha256);
      const tmpPath = string(body.tmpPath);
      const size = body.size;
      if (
        !linkId ||
        !localVaultId ||
        !sha256 ||
        !tmpPath ||
        typeof size !== "number"
      )
        return undefined;
      return {
        kind: "pull-blob",
        edgeId,
        linkId,
        localVaultId,
        sha256,
        size,
        tmpPath,
      };
    }
    default:
      return undefined;
  }
}

function payloadOf(effect: ShareEffect): Record<string, unknown> {
  const { kind, edgeId, ...rest } = effect;
  void kind;
  void edgeId;
  return rest;
}

/**
 * Enqueue an obligation. The primary key is DERIVED from what the effect is
 * about, so re-enqueuing after a crash (or a second identical answer) lands
 * on the same row instead of duplicating work. `awaitsHuman` is the
 * 'await-answer' case: a NULL `next_attempt_at` means no machine ever picks
 * this up — only an owner's answer closes it.
 */
export function enqueueShareEffect(
  db: GatewayDatabase,
  effect: ShareEffect,
  options: { awaitsHuman?: boolean; requeue?: boolean; now?: number } = {}
): string {
  const effectId = effectIdFor(effect);
  const now = options.now ?? Date.now();
  const iso = new Date(now).toISOString();
  const nextAttempt = options.awaitsHuman ? null : now;
  const conflict = options.requeue
    ? `DO UPDATE SET status = 'queued', attempts = 0,
         next_attempt_at = excluded.next_attempt_at,
         payload_json = excluded.payload_json, updated_at = excluded.updated_at`
    : "DO NOTHING";
  db.run(
    `INSERT INTO share_effects
       (effect_id, edge_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
     ON CONFLICT (effect_id) ${conflict}`,
    effectId,
    effect.edgeId,
    effect.kind,
    JSON.stringify(payloadOf(effect)),
    nextAttempt,
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

/**
 * Not yet — try again later. `progressed` is the resumable-transfer case: a
 * pull that moved bytes but has not finished has not failed at anything, so
 * it must not be pushed down an exponential backoff it never earned.
 */
export function deferShareEffect(
  db: GatewayDatabase,
  effectId: string,
  options: { attempts: number; progressed?: boolean; now?: number }
): void {
  const now = options.now ?? Date.now();
  const attempts = options.progressed ? 0 : options.attempts + 1;
  const delay = options.progressed
    ? 0
    : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
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

function selectEffects(
  db: GatewayDatabase,
  kind: ShareEffectKind,
  where: string,
  ...params: Array<string | number>
): PendingShareEffect[] {
  const rows = db.db
    .prepare(
      `SELECT * FROM share_effects
        WHERE kind = ? AND status = 'queued' ${where}
        ORDER BY created_at`
    )
    .all(kind, ...params) as unknown as ShareEffectRow[];
  return rows.flatMap((row) => {
    const effect = parseShareEffectRow(row);
    return effect
      ? [{ effectId: row.effect_id, attempts: row.attempts, effect }]
      : [];
  });
}

/** Every give still awaiting a human answer — the P6 surface's one read. */
export function listQueuedEffects(
  db: GatewayDatabase,
  kind: ShareEffectKind
): PendingShareEffect[] {
  return selectEffects(db, kind, "");
}

export function findQueuedEffect(
  db: GatewayDatabase,
  kind: ShareEffectKind,
  edgeId: string
): PendingShareEffect | undefined {
  return selectEffects(db, kind, "AND edge_id = ?", edgeId)[0];
}

/** Whether a pull for these exact bytes is already owed — sha-level dedupe. */
export function hasQueuedBlobPull(
  db: GatewayDatabase,
  localVaultId: string,
  sha256: string
): boolean {
  return listQueuedEffects(db, "pull-blob").some(
    (pending) =>
      pending.effect.kind === "pull-blob" &&
      pending.effect.localVaultId === localVaultId &&
      pending.effect.sha256 === sha256
  );
}
