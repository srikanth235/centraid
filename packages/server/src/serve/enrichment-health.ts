/*
 * Per-enricher recent-run health. Never-fired is `ok` (unknown, not a
 * failure) — do not fabricate run history from other automations' ledgers.
 */

import { SYSTEM_AUTOMATION_IDS } from "../enrich/system-recognition.js";
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

/**
 * WHERE THE WALK HAS GOT TO (#1014, B2). Recent-run health alone reported `ok`
 * forever on a recipe whose cursor had not moved in a month: every fire
 * SUCCEEDED, and did nothing. A watermark that has not advanced while targets
 * are failing is `degraded`, not `ok`.
 */
export interface EnrichmentProgress {
  /** Targets this capability has derived, and targets it could derive. */
  readonly done: number;
  readonly total: number;
  /** When the cursor last MOVED, not when the automation last ran. */
  readonly advancedAt?: number;
}

/** Per-capability poison register counts (`enrich_target_failure`). */
export interface EnrichmentTargetFailures {
  readonly capability: string;
  readonly declined: number;
  readonly failing: number;
}

export interface EnrichmentHealthVaultEntry {
  readonly vaultId: string;
  readonly listAutomations: () => Promise<readonly EnrichmentAutomationRow[]>;
  readonly recentRuns: (
    automationRef: string,
    limit: number
  ) => readonly EnrichmentRunOutcome[];
  /** Cursor position vs library size for one enricher; undefined = unknown. */
  readonly progress?: (automationId: string) => EnrichmentProgress | undefined;
  /** The vault's poison register, per capability. */
  readonly targetFailures?: () => readonly EnrichmentTargetFailures[];
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
  const systemIds = new Set<string>(SYSTEM_AUTOMATION_IDS);

  return async () => {
    let enabledTotal = 0;
    let installedTotal = 0;
    const persistentlyFailing: string[] = [];
    const recentlyFailing: string[] = [];
    const stale: string[] = [];
    const frozen: string[] = [];
    const poisoned: string[] = [];

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
      // WHAT THE SCHEDULER ACTUALLY ARMS (#1014, B21). A system recipe has no
      // `enabled` question to answer — install rewrites the catalogue's flag
      // every boot and reconcile arms the row unconditionally
      // (docs/recognition-automations.md) — so skipping it here on a stale
      // `false` made health and the scheduler disagree about what is running.
      for (const row of rows) {
        if (!ids.has(row.id)) continue;
        installedTotal += 1;
        const armed = row.enabled || systemIds.has(row.id);
        if (!armed) continue;
        enabledTotal += 1;
        const tag = `${vault.vaultId.slice(0, 8)}/${row.id}`;
        const progress = vault.progress?.(row.id);
        if (
          progress !== undefined &&
          progress.done < progress.total &&
          progress.advancedAt !== undefined &&
          now() - progress.advancedAt > staleAfterMs
        ) {
          const hours = Math.round((now() - progress.advancedAt) / 3_600_000);
          frozen.push(
            `${tag} (${progress.done}/${progress.total}, cursor still ${hours}h ago)`
          );
        }
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

    // The poison register, collected once per vault rather than per recipe.
    for (const result of vaultRows) {
      if (!result) continue;
      for (const entry of result.vault.targetFailures?.() ?? []) {
        if (entry.declined === 0 && entry.failing === 0) continue;
        poisoned.push(
          `${result.vault.vaultId.slice(0, 8)}/${entry.capability}: ` +
            `${entry.declined} declined, ${entry.failing} retrying`
        );
      }
    }

    const enabledNote = `${enabledTotal} of ${installedTotal} enricher${installedTotal === 1 ? "" : "s"} armed`;
    if (persistentlyFailing.length > 0) {
      return {
        status: "error",
        detail: `${enabledNote} — persistently failing: ${persistentlyFailing.join(", ")}`,
      };
    }
    if (
      recentlyFailing.length > 0 ||
      stale.length > 0 ||
      frozen.length > 0 ||
      poisoned.length > 0
    ) {
      const parts: string[] = [];
      if (recentlyFailing.length > 0)
        parts.push(`recent failure: ${recentlyFailing.join(", ")}`);
      if (stale.length > 0) parts.push(`stale: ${stale.join(", ")}`);
      // A FROZEN WATERMARK IS NOT HEALTHY. Every fire succeeded and the walk
      // did not move — the exact shape one poisoned asset used to produce.
      if (frozen.length > 0) parts.push(`no progress: ${frozen.join(", ")}`);
      if (poisoned.length > 0)
        parts.push(`declined targets: ${poisoned.join(", ")}`);
      return {
        status: "degraded",
        detail: `${enabledNote} — ${parts.join("; ")}`,
      };
    }
    return { status: "ok", detail: enabledNote };
  };
}
