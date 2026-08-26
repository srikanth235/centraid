// blob-sweep health probe (#351, #367): last `reconcile()` outcome per vault
// + custody-state counts. No s3 configured is ok — local-only is the default
// topology.

import type { HealthProbe } from "./health-registry.js";

export interface BlobCustodyCounts {
  readonly "pending-offsite"?: number;
  readonly "local-only": number;
  readonly replicated: number;
  readonly "remote-only": number;
  readonly missing: number;
}

export interface BlobSweepHealthVaultEntry {
  readonly vaultId: string;
  readonly s3Configured: () => boolean;
  /** `custodyStateCounts(db.vault)` — no tier I/O. */
  readonly counts: () => BlobCustodyCounts;
  /** `db.blobs.sweepStatus()`. */
  readonly sweepStatus: () => {
    lastCompletedAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
  };
}

export interface BlobSweepHealthOptions {
  readonly vaults: () => readonly BlobSweepHealthVaultEntry[];
  /** Failure streak before "persistently failing". Default 3. */
  readonly persistentFailureStreak?: number;
  /** Max age of last success before an s3 vault with backlog is stale. Default 1h. */
  readonly staleAfterMs?: number;
  /** Clock override (tests). */
  readonly now?: () => number;
}

const DEFAULT_STREAK = 3;
const DEFAULT_STALE_MS = 60 * 60 * 1000;

export function createBlobSweepHealthProbe(
  options: BlobSweepHealthOptions
): HealthProbe {
  const now = options.now ?? Date.now;
  const streak = options.persistentFailureStreak ?? DEFAULT_STREAK;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;

  return async () => {
    const vaults = options.vaults();
    let s3VaultCount = 0;
    let localOnlyTotal = 0;
    let pendingOffsiteTotal = 0;
    let replicatedTotal = 0;
    const persistentlyFailing: string[] = [];
    const recentlyFailingOrStale: string[] = [];

    for (const vault of vaults) {
      const counts = vault.counts();
      localOnlyTotal += counts["local-only"];
      pendingOffsiteTotal += counts["pending-offsite"] ?? 0;
      replicatedTotal += counts.replicated;
      if (!vault.s3Configured()) continue;
      s3VaultCount += 1;
      const tag = vault.vaultId.slice(0, 8);
      const status = vault.sweepStatus();

      if (status.consecutiveFailures > 0) {
        const note = `${tag} (${status.consecutiveFailures}x: ${status.lastError ?? "unknown error"})`;
        if (status.consecutiveFailures >= streak)
          persistentlyFailing.push(note);
        else recentlyFailingOrStale.push(note);
        continue;
      }
      if (!status.lastCompletedAt) {
        // s3 configured, sweep never completed: report it, don't fabricate ok.
        recentlyFailingOrStale.push(`${tag} (sweep never ran)`);
        continue;
      }
      const age = now() - Date.parse(status.lastCompletedAt);
      const backlog = counts["local-only"] + (counts["pending-offsite"] ?? 0);
      if (Number.isFinite(age) && age > staleAfterMs && backlog > 0) {
        const ageS = Math.round(age / 1000);
        recentlyFailingOrStale.push(
          `${tag} (last swept ${ageS}s ago, backlog ${backlog})`
        );
      }
    }

    const backlogDetail =
      `${pendingOffsiteTotal} pending-offsite, ${localOnlyTotal} local-only, ` +
      `${replicatedTotal} replicated`;
    if (persistentlyFailing.length > 0) {
      return {
        status: "error",
        detail:
          `${s3VaultCount} vault(s) with s3 configured — persistently failing: ` +
          `${persistentlyFailing.join(", ")}; ${backlogDetail}`,
      };
    }
    if (recentlyFailingOrStale.length > 0) {
      return {
        status: "degraded",
        detail:
          `${s3VaultCount} vault(s) with s3 configured — ${recentlyFailingOrStale.join(", ")}; ` +
          backlogDetail,
      };
    }
    if (s3VaultCount === 0) {
      return {
        status: "ok",
        detail: `no s3 tier configured — ${localOnlyTotal} local-only blob(s)`,
      };
    }
    return {
      status: "ok",
      detail: `${s3VaultCount} vault(s) with s3 configured — ${backlogDetail}`,
    };
  };
}
