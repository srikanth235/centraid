/*
 * Per-enricher recent-run health. Never-fired is `ok` (unknown, not a
 * failure) — do not fabricate run history from other automations' ledgers.
 */

import type { HealthProbe } from "./health-registry.js";

/** Bundled enricher ids (`ownerApp === id`); do not read blueprints at runtime. */
export const ENRICHER_AUTOMATION_IDS = [
  "photo-ocr",
  "transcript",
  "embed-image",
  "embed-text",
  "faces",
  "doc-text-extractor",
  "doc-filer",
  "doc-entity-linker",
  "obligation-extractor",
  "renewal-reminders",
] as const;

export interface EnrichmentAutomationRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly ref: string;
}

export interface EnrichmentRunOutcome {
  readonly ok: boolean;
  readonly endedAt?: number;
}

export interface EnrichmentHealthVaultEntry {
  readonly vaultId: string;
  readonly listAutomations: () => Promise<readonly EnrichmentAutomationRow[]>;
  readonly recentRuns: (
    automationRef: string,
    limit: number
  ) => readonly EnrichmentRunOutcome[];
}

export interface EnrichmentHealthOptions {
  readonly vaults: () => readonly EnrichmentHealthVaultEntry[];
  readonly persistentFailureStreak?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => number;
}

const DEFAULT_STREAK = 3;
const DEFAULT_STALE_MS = 48 * 60 * 60 * 1000;

export function createEnrichmentHealthProbe(
  options: EnrichmentHealthOptions
): HealthProbe {
  const now = options.now ?? Date.now;
  const streak = options.persistentFailureStreak ?? DEFAULT_STREAK;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
  const ids = new Set<string>(ENRICHER_AUTOMATION_IDS);

  return async () => {
    let enabledTotal = 0;
    let installedTotal = 0;
    const persistentlyFailing: string[] = [];
    const recentlyFailing: string[] = [];
    const stale: string[] = [];

    const vaultRows = await Promise.all(
      options.vaults().map(async (vault) => {
        try {
          return { vault, rows: await vault.listAutomations() };
        } catch {
          // Unsettled/unmounted vault — `vaults` already flags a failed mount.
          return undefined;
        }
      })
    );
    for (const result of vaultRows) {
      if (!result) continue;
      const { vault, rows } = result;
      for (const row of rows) {
        if (!ids.has(row.id)) continue;
        installedTotal += 1;
        if (!row.enabled) continue;
        enabledTotal += 1;
        const tag = `${vault.vaultId.slice(0, 8)}/${row.id}`;
        const runs = vault.recentRuns(row.ref, streak);
        if (runs.length === 0) continue; // never fired — honest "unknown", not a failure
        const latest = runs[0]!;
        if (latest.ok) {
          if (
            latest.endedAt !== undefined &&
            now() - latest.endedAt > staleAfterMs
          ) {
            const hours = Math.round((now() - latest.endedAt) / 3_600_000);
            stale.push(`${tag} (last ok ${hours}h ago)`);
          }
          continue;
        }
        if (runs.length >= streak && runs.every((r) => !r.ok)) {
          persistentlyFailing.push(tag);
        } else {
          recentlyFailing.push(tag);
        }
      }
    }

    const enabledNote = `${enabledTotal} of ${installedTotal} enricher${installedTotal === 1 ? "" : "s"} enabled`;
    if (persistentlyFailing.length > 0) {
      return {
        status: "error",
        detail: `${enabledNote} — persistently failing: ${persistentlyFailing.join(", ")}`,
      };
    }
    if (recentlyFailing.length > 0 || stale.length > 0) {
      const parts: string[] = [];
      if (recentlyFailing.length > 0)
        parts.push(`recent failure: ${recentlyFailing.join(", ")}`);
      if (stale.length > 0) parts.push(`stale: ${stale.join(", ")}`);
      return {
        status: "degraded",
        detail: `${enabledNote} — ${parts.join("; ")}`,
      };
    }
    return { status: "ok", detail: enabledNote };
  };
}
