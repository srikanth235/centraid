/**
 * Condition-trigger evaluation — the "time lives in the data" half of the
 * duaility trigger model.
 *
 * A condition trigger declares a consented vault read (`entity` + `where`);
 * the cursor engine reads it on the trigger's gate under the automation's
 * enrolled-agent grant, and delivers one element per row it has not seen
 * before. Dedup is by row CONTENT: each matched row is hashed whole,
 * and the set of hashes currently matching is the cursor (persisted in the
 * automation's cross-run state under a reserved key). Consequences:
 *
 *   - a row that stays matched across evaluations fires exactly once;
 *   - a row that changes (an invoice reschedule bumps `sequence`, a renewal
 *     moves `due_at`) fires again — a changed row is a new event;
 *   - a row that leaves the window and later re-enters fires again, which is
 *     what a reminder wants.
 *
 * A receipted consent deny — or any bridge error — throws, so the engine
 * records the failure against the trigger and leaves the cursor where it was;
 * failure never widens access and never advances past undelivered rows.
 */

import { createHash } from "node:crypto";

import type { VaultBridge } from "@centraid/server/engine";

import type { ConditionTrigger, DataTrigger } from "../manifest/manifest.js";
import { parseRef } from "../manifest/ref.js";
import type { CursorReadResult } from "./cursor-engine.js";

/*
 * `__trigger:` stays a reserved `automation_state` key prefix: handlers share
 * that KV namespace via `ctx.state`. Durable trigger positions live in
 * `automation_trigger_cursor` (see `cursor-engine.ts`), so nothing in this
 * module writes the prefix.
 */

/** Cap on remembered hashes — beyond this the oldest matches re-fire. */
const MAX_SEEN_HASHES = 2000;

function rowHash(row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort();
  const canonical = JSON.stringify(keys.map((k) => [k, row[k]]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export interface ReadConditionCursorOptions {
  automationRef: string;
  trigger: ConditionTrigger;
  purpose: string;
  vault: VaultBridge;
  positionJson?: string;
  limit: number;
  now: Date;
}

function stringArrayPosition(positionJson: string | undefined): string[] {
  if (!positionJson) return [];
  try {
    const parsed = JSON.parse(positionJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** Derived-query cursor source: content hashes are its ordered position set. */
export async function readConditionCursor(
  options: ReadConditionCursorOptions
): Promise<CursorReadResult> {
  if (!parseRef(options.automationRef)) {
    throw new Error(`invalid ref ${options.automationRef}`);
  }
  const result = await options.vault({
    op: "read",
    payload: {
      entity: options.trigger.entity,
      ...(options.trigger.where ? { where: options.trigger.where } : {}),
      purpose: options.purpose,
      limit: 1000,
    },
  });
  if (!result.ok) {
    throw new Error(
      `${result.code ?? "VAULT_ERROR"}: ${result.error ?? "vault read failed"}`
    );
  }
  const rows = (
    (result.result as { rows?: Record<string, unknown>[] })?.rows ?? []
  ).slice();
  const seen = new Set(stringArrayPosition(options.positionJson));
  const current = rows.map(rowHash);
  const fresh = rows
    .map((row, index) => ({ row, hash: current[index]! }))
    .filter(({ hash }) => !seen.has(hash));
  const delivered = fresh.slice(0, options.limit);
  const deliveredHashes = new Set(delivered.map(({ hash }) => hash));
  // The committed position advances over DELIVERED rows only: a match beyond
  // the cap stays unseen and arrives on the next gate tick. Rows that left the
  // window are dropped from the set, which is what makes a re-entry fire again.
  const position = current.filter(
    (hash) => seen.has(hash) || deliveredHashes.has(hash)
  );
  const occurredAt = options.now.getTime();
  return {
    elements: delivered.map(({ row, hash }) => ({
      // One position per DELIVERY OCCURRENCE, not per row content. The host
      // derives its idempotency run id from this, so a row that leaves the
      // window and re-enters unchanged — the documented reminder behaviour —
      // must not collide with the run that fired the first time. Rows still
      // matching are suppressed by the hash set above, never by this id.
      position: `${hash}:${occurredAt}`,
      occurredAt,
      payload: row,
    })),
    positionJson: JSON.stringify(position.slice(0, MAX_SEEN_HASHES)),
    skipped: 0,
  };
}

export interface ReadDataCursorOptions {
  automationRef: string;
  trigger: DataTrigger;
  purpose: string;
  vault: VaultBridge;
  positionJson?: string;
  limit: number;
  now: Date;
}

function scalarPosition(positionJson: string | undefined): string | null {
  if (!positionJson) return null;
  try {
    const parsed = JSON.parse(positionJson) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** The feed-native watermark of one change entry, when it carries one. */
function changeId(change: Record<string, unknown>): string | undefined {
  for (const key of ["id", "provId", "provenanceId", "cursor"]) {
    const value = change[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function changePosition(
  change: Record<string, unknown>,
  index: number
): string {
  return changeId(change) ?? `${rowHash(change)}:${index}`;
}

/** Vault provenance cursor source. Missing position bootstraps from now. */
export async function readDataCursor(
  options: ReadDataCursorOptions
): Promise<CursorReadResult> {
  if (!parseRef(options.automationRef)) {
    throw new Error(`invalid ref ${options.automationRef}`);
  }
  const cursor = scalarPosition(options.positionJson);
  // Pull exactly what one fire may carry. The feed's returned watermark is the
  // last row it returned, so delivering the whole pull is the ONLY way the
  // committed position stays at a delivered element; over-pulling and slicing
  // would advance past entries no fire ever saw. A backlog beyond the cap is
  // still durably in the journal — the next gate tick reads it.
  const result = await options.vault({
    op: "changes",
    payload: {
      entities: [...options.trigger.entities],
      purpose: options.purpose,
      cursor,
      limit: options.limit,
    },
  });
  if (!result.ok) {
    throw new Error(
      `${result.code ?? "VAULT_ERROR"}: ${result.error ?? "vault changes failed"}`
    );
  }
  const feed = result.result as {
    changes?: Record<string, unknown>[];
    cursor?: string;
  };
  const changes = feed.changes ?? [];
  // The bootstrap pull (no stored position) intentionally never fires: a fresh
  // watcher reacts to what happens next, not to the whole journal.
  const visible = cursor === null ? [] : changes;
  return {
    elements: visible.map((change, index) => {
      // Only a feed-native id is a legal watermark; a synthesized position
      // identifies the delivery but must never be committed as one.
      const watermark = changeId(change);
      return {
        position: changePosition(change, index),
        occurredAt: options.now.getTime(),
        payload: change,
        ...(watermark === undefined
          ? {}
          : { positionJson: JSON.stringify(watermark) }),
      };
    }),
    ...(typeof feed.cursor === "string"
      ? { positionJson: JSON.stringify(feed.cursor) }
      : {}),
    skipped: 0,
  };
}
