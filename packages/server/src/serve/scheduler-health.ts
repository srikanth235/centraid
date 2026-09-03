import type { SchedulerLedgerSnapshot } from "@centraid/server/automation";

import type { HealthProbe } from "./health-registry.js";

export interface SchedulerHealthVaultEntry {
  readonly vaultId: string;
  readonly snapshot: () => SchedulerLedgerSnapshot;
}

export interface SchedulerHealthOptions {
  readonly vaults: () => readonly SchedulerHealthVaultEntry[];
  readonly periodMs?: number;
  readonly staleAfterPeriods?: number;
  readonly now?: () => number;
}

export function createSchedulerHealthProbe(
  options: SchedulerHealthOptions
): HealthProbe {
  const now = options.now ?? Date.now;
  const periodMs = options.periodMs ?? 60_000;
  const staleMs = periodMs * (options.staleAfterPeriods ?? 3);

  return async () => {
    const vaults = options.vaults();
    const stale: string[] = [];
    let missedTotal = 0;
    let latest: { recordedAt: string; label: string } | undefined;

    for (const vault of vaults) {
      const snapshot = vault.snapshot();
      const tag = vault.vaultId.slice(0, 8);
      if (snapshot.lastTickAt && !snapshot.dormant) {
        const age = now() - Date.parse(snapshot.lastTickAt);
        if (Number.isFinite(age) && age > staleMs) {
          stale.push(`${tag} (last tick ${Math.round(age / 1000)}s ago)`);
        }
      }
      missedTotal += snapshot.missed.length;
      const last = snapshot.missed.at(-1);
      if (last && (!latest || last.recordedAt > latest.recordedAt)) {
        latest = {
          recordedAt: last.recordedAt,
          label: `${last.automationRef} scheduled for ${last.scheduledFor}`,
        };
      }
    }

    const notes: string[] = [];
    if (stale.length > 0) notes.push(`tick stale: ${stale.join(", ")}`);
    if (missedTotal > 0) {
      notes.push(
        `${missedTotal} missed automation window${missedTotal === 1 ? "" : "s"} recorded` +
          (latest ? ` — latest ${latest.label}` : "")
      );
    }
    if (notes.length === 0) {
      return {
        status: "ok",
        detail: `${vaults.length} vault scheduler${vaults.length === 1 ? "" : "s"} healthy`,
      };
    }
    return { status: "degraded", detail: notes.join("; ") };
  };
}
