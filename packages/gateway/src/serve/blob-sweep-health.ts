/*
 * Blob custody-sweep health — the `blob-sweep` component (issue #351 wave 4,
 * #367 prep).
 *
 * `db.blobs.reconcile()` (the standing replication/reconciliation sweep,
 * `packages/vault/src/blob/custody.ts`) already runs on a timer per mounted
 * vault (`VaultPlane.runSweep`, detached, one call per lifecycle tick) — it
 * is NOT unscheduled today, contrary to a "nothing runs this yet" worry.
 * What was missing is a readable trace of its outcome: a failure only ever
 * logged a one-line warn, and nobody could ask "when did this last succeed,
 * and on what". `BlobCustody.sweepStatus()` (this wave) closes that gap; this
 * probe reads it, plus a cheap GROUP BY over the `blob_custody_state` mirror
 * (`custodyStateCounts`) for the local-only-vs-replicated backlog — the same
 * counts issue #367's Storage UI card will want per vault, so the shape is
 * chosen to serve both without a second query.
 *
 * A vault with no `blob_store` configured is not a degraded state — it is
 * the default, local-only topology — so `ok` covers "no s3 configured" the
 * same way `broker`'s probe treats "no broker-carried connections" as ok.
 */

import type { HealthProbe } from './health-registry.js';

/** One custody-state bucket count, as `custodyStateCounts` returns it. */
export interface BlobCustodyCounts {
  readonly 'local-only': number;
  readonly replicated: number;
  readonly 'remote-only': number;
  readonly missing: number;
}

export interface BlobSweepHealthVaultEntry {
  readonly vaultId: string;
  /** Whether this vault's `blob_store` settings currently declare an s3 tier. */
  readonly s3Configured: () => boolean;
  /** `custodyStateCounts(db.vault)` — cheap GROUP BY, no tier I/O. */
  readonly counts: () => BlobCustodyCounts;
  /** `db.blobs.sweepStatus()` — the last `reconcile()` outcome, in-memory. */
  readonly sweepStatus: () => {
    lastCompletedAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
  };
}

export interface BlobSweepHealthOptions {
  readonly vaults: () => readonly BlobSweepHealthVaultEntry[];
  /** How many consecutive sweep failures before a vault counts "persistently" failing. Defaults to 3. */
  readonly persistentFailureStreak?: number;
  /** How long since the last successful sweep before an s3-configured vault with a backlog counts stale. Defaults to 1h. */
  readonly staleAfterMs?: number;
  /** Clock override (tests). */
  readonly now?: () => number;
}

const DEFAULT_STREAK = 3;
const DEFAULT_STALE_MS = 60 * 60 * 1000;

/** Builds the `blob-sweep` component's `HealthProbe` (registered in `build-gateway.ts`). */
export function createBlobSweepHealthProbe(options: BlobSweepHealthOptions): HealthProbe {
  const now = options.now ?? Date.now;
  const streak = options.persistentFailureStreak ?? DEFAULT_STREAK;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;

  return async () => {
    const vaults = options.vaults();
    let s3VaultCount = 0;
    let localOnlyTotal = 0;
    let replicatedTotal = 0;
    const persistentlyFailing: string[] = [];
    const recentlyFailingOrStale: string[] = [];

    for (const vault of vaults) {
      const counts = vault.counts();
      localOnlyTotal += counts['local-only'];
      replicatedTotal += counts.replicated;
      if (!vault.s3Configured()) continue;
      s3VaultCount += 1;
      const tag = vault.vaultId.slice(0, 8);
      const status = vault.sweepStatus();

      if (status.consecutiveFailures > 0) {
        const note = `${tag} (${status.consecutiveFailures}x: ${status.lastError ?? 'unknown error'})`;
        if (status.consecutiveFailures >= streak) persistentlyFailing.push(note);
        else recentlyFailingOrStale.push(note);
        continue;
      }
      if (!status.lastCompletedAt) {
        // s3 configured but the sweep has never once completed here — the
        // honest signal, not a fabricated "ok".
        recentlyFailingOrStale.push(`${tag} (sweep never ran)`);
        continue;
      }
      const age = now() - Date.parse(status.lastCompletedAt);
      if (Number.isFinite(age) && age > staleAfterMs && counts['local-only'] > 0) {
        const ageS = Math.round(age / 1000);
        recentlyFailingOrStale.push(
          `${tag} (last swept ${ageS}s ago, backlog ${counts['local-only']})`,
        );
      }
    }

    const backlogDetail = `${localOnlyTotal} local-only, ${replicatedTotal} replicated`;
    if (persistentlyFailing.length > 0) {
      return {
        status: 'error',
        detail:
          `${s3VaultCount} vault(s) with s3 configured — persistently failing: ` +
          `${persistentlyFailing.join(', ')}; ${backlogDetail}`,
      };
    }
    if (recentlyFailingOrStale.length > 0) {
      return {
        status: 'degraded',
        detail:
          `${s3VaultCount} vault(s) with s3 configured — ${recentlyFailingOrStale.join(', ')}; ` +
          backlogDetail,
      };
    }
    if (s3VaultCount === 0) {
      return {
        status: 'ok',
        detail: `no s3 tier configured — ${localOnlyTotal} local-only blob(s)`,
      };
    }
    return {
      status: 'ok',
      detail: `${s3VaultCount} vault(s) with s3 configured — ${backlogDetail}`,
    };
  };
}
