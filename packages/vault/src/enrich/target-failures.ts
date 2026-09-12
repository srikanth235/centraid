// THE THIRD ANSWER (#1014, B2/B3/B20/R10).
//
// A recognition recipe walks the library in `asset_id` order and stamps what
// it derives. Until now a target it could NOT derive — a detector that threw,
// a preview the codec never produced, a delegate that was never wired — was
// neither stamped nor recorded, so the ordered walk met it again on the next
// tick and every tick after that. Every later photograph waited behind one bad
// row, forever, while `enrichment-health` reported `ok` because the automation
// itself never failed: it just did nothing, successfully.
//
// "Derived" and "skipped" were the only two outcomes. This is the third:
// COUNTED. Under the cap the walk retries the target on a later pass; at the
// cap it is DECLINED — the cursor moves past it and health lists it — so the
// poison is recorded rather than blocking.

import type { DatabaseSync } from "node:sqlite";

/**
 * Failures one target is allowed before the walk declines it. Three is a
 * transient-versus-permanent test, not a budget: a detector that failed three
 * separate times on three separate ticks over the same bytes is not going to
 * succeed on the fourth, and the member is better served by the rest of their
 * library moving.
 */
export const ENRICH_TARGET_MAX_FAILURES = 3;

export interface EnrichTargetFailureVerdict {
  readonly failures: number;
  readonly declined: boolean;
  readonly reason?: string;
}

export interface EnrichTargetFailureRow {
  readonly capability: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly failures: number;
  readonly declined: boolean;
  readonly reason?: string;
  readonly lastError?: string;
  readonly lastFailedAt: string;
}

function iso(value: string | Date | undefined): string {
  const date =
    value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("invalid failure clock");
  return date.toISOString();
}

/**
 * Count one failure against a target and say whether the walk should now
 * decline it. `permanent` short-circuits the count: a preview the codec
 * refuses outright, or content past the extractor's byte ceiling, will not
 * become derivable by being tried twice more.
 */
export function recordEnrichTargetFailure(
  vault: DatabaseSync,
  input: {
    capability: string;
    targetType: string;
    targetId: string;
    error?: string;
    reason?: string;
    permanent?: boolean;
    maxFailures?: number;
    now?: string | Date;
  }
): EnrichTargetFailureVerdict {
  const at = iso(input.now);
  const cap = Math.max(1, input.maxFailures ?? ENRICH_TARGET_MAX_FAILURES);
  const error = input.error?.slice(0, 500) ?? null;
  const row = vault
    .prepare(
      `INSERT INTO enrich_target_failure
         (capability, target_type, target_id, failures, declined, reason,
          last_error, first_failed_at, last_failed_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(capability, target_type, target_id) DO UPDATE SET
         failures = enrich_target_failure.failures + 1,
         declined = CASE
           WHEN excluded.declined = 1 THEN 1
           WHEN enrich_target_failure.failures + 1 >= ? THEN 1
           ELSE 0 END,
         reason = COALESCE(excluded.reason, enrich_target_failure.reason),
         last_error = excluded.last_error,
         last_failed_at = excluded.last_failed_at
       RETURNING failures, declined, reason`
    )
    .get(
      input.capability,
      input.targetType,
      input.targetId,
      input.permanent === true || cap <= 1 ? 1 : 0,
      input.reason ?? null,
      error,
      at,
      at,
      cap
    ) as { failures: number; declined: number; reason: string | null };
  return {
    failures: row.failures,
    declined: row.declined === 1,
    ...(row.reason === null ? {} : { reason: row.reason }),
  };
}

/**
 * Forget a target's failures. Called where a derivation is STAMPED: producing
 * the value is the only proof that the poison is gone, and without this a
 * transient failure would leave health listing a target that is now fine.
 */
export function clearEnrichTargetFailure(
  vault: DatabaseSync,
  input: { capability: string; targetType?: string; targetId: string }
): void {
  vault
    .prepare(
      `DELETE FROM enrich_target_failure
        WHERE capability = ? AND target_id = ?
          AND (? IS NULL OR target_type = ?)`
    )
    .run(
      input.capability,
      input.targetId,
      input.targetType ?? null,
      input.targetType ?? null
    );
}

/** Is this target one the walk has already given up on? */
export function isEnrichTargetDeclined(
  vault: DatabaseSync,
  input: { capability: string; targetId: string }
): boolean {
  const row = vault
    .prepare(
      `SELECT 1 AS hit FROM enrich_target_failure
        WHERE capability = ? AND target_id = ? AND declined = 1 LIMIT 1`
    )
    .get(input.capability, input.targetId) as { hit: number } | undefined;
  return row !== undefined;
}

/** What health reports: per capability, how many are declined and how many are still counting. */
export function enrichTargetFailureSummary(
  vault: DatabaseSync
): { capability: string; declined: number; failing: number }[] {
  return (
    vault
      .prepare(
        `SELECT capability,
                SUM(CASE WHEN declined = 1 THEN 1 ELSE 0 END) AS declined,
                SUM(CASE WHEN declined = 0 THEN 1 ELSE 0 END) AS failing
           FROM enrich_target_failure
          GROUP BY capability
          ORDER BY capability`
      )
      .all() as { capability: string; declined: number; failing: number }[]
  ).map((row) => ({
    capability: row.capability,
    declined: Number(row.declined ?? 0),
    failing: Number(row.failing ?? 0),
  }));
}

/** The declined targets themselves, newest first, for a health detail line. */
export function declinedEnrichTargets(
  vault: DatabaseSync,
  limit = 20
): EnrichTargetFailureRow[] {
  return (
    vault
      .prepare(
        `SELECT capability, target_type, target_id, failures, declined, reason,
                last_error, last_failed_at
           FROM enrich_target_failure
          WHERE declined = 1
          ORDER BY last_failed_at DESC
          LIMIT ?`
      )
      .all(Math.max(1, Math.trunc(limit))) as {
      capability: string;
      target_type: string;
      target_id: string;
      failures: number;
      declined: number;
      reason: string | null;
      last_error: string | null;
      last_failed_at: string;
    }[]
  ).map((row) => ({
    capability: row.capability,
    targetType: row.target_type,
    targetId: row.target_id,
    failures: row.failures,
    declined: row.declined === 1,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    lastFailedAt: row.last_failed_at,
  }));
}
