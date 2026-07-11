/*
 * Enricher-automation health — the `enrichment` component (issue #351
 * wave 4).
 *
 * Enrichers are ordinary automations (issue #299 phases 1-2): each bundled
 * template (`packages/blueprints/automations/<id>`) ships as its own
 * single-automation app, `enabled: false` by default — enabling one IS the
 * owner's opt-in. That means the generic `automations`/`automation-runs`
 * components already cover their fire-time failures, the same way
 * `connections` already covers every dead credential. This probe is
 * narrower, the same way `broker` narrows `connections`: how many enrichers
 * are actually turned on, and — per enricher — is its OWN recent run history
 * healthy, not just "did automations run at all".
 *
 * Run history is not fabricated: it's the SAME ledger `ctx.runs` and any
 * "recent runs" view already read (`ConversationStore.listAutomationTurns`,
 * `packages/app-engine`), keyed by automation ref. An enricher that has
 * never fired yet reports `ok` — a quiet, freshly-enabled enricher is not a
 * failure, it just hasn't had a trigger yet; that is the "unknown, not
 * faked" case the task called for.
 */

import type { HealthProbe } from './health-registry.js';

/** The bundled enricher automation ids (`packages/blueprints/automations/*`)
 *  — mirrors `packages/automation/src/manifest/enricher-templates.test.ts`'s
 *  `ENRICHERS` fixture. Each ships as its own single-automation app
 *  (`ownerApp === id`), so this id set alone identifies them among any
 *  vault's installed automations without needing to read blueprints' own
 *  package layout at runtime. */
export const ENRICHER_AUTOMATION_IDS = [
  'photo-captioner',
  'doc-text-extractor',
  'screenshot-extractor',
  'doc-filer',
  'face-proposer',
  'trip-albums',
  'doc-entity-linker',
  'obligation-extractor',
  'renewal-reminders',
] as const;

/** An installed automation row, narrowed to what this probe needs (`automation.list`'s `Row`). */
export interface EnrichmentAutomationRow {
  readonly id: string;
  readonly enabled: boolean;
  /** Globally-unique handle (`<ownerApp>/<id>`) — `ConversationStore.listAutomationTurns`'s key. */
  readonly ref: string;
}

/** One run's outcome, narrowed from `ConversationStore`'s `Turn`. */
export interface EnrichmentRunOutcome {
  readonly ok: boolean;
  readonly endedAt?: number;
}

export interface EnrichmentHealthVaultEntry {
  readonly vaultId: string;
  /** Installed automation apps — the same read the scheduler reconcile uses (`automation.list`). */
  readonly listAutomations: () => Promise<readonly EnrichmentAutomationRow[]>;
  /** Newest-first run history for one automation ref, bounded by `limit` (`ConversationStore.listAutomationTurns`). */
  readonly recentRuns: (automationRef: string, limit: number) => readonly EnrichmentRunOutcome[];
}

export interface EnrichmentHealthOptions {
  readonly vaults: () => readonly EnrichmentHealthVaultEntry[];
  /** How many of an enricher's most recent runs must ALL fail before it counts "persistently" failing. Defaults to 3. */
  readonly persistentFailureStreak?: number;
  /** How long since the last SUCCESSFUL run before an enabled-but-quiet enricher counts stale. Defaults to 48h. */
  readonly staleAfterMs?: number;
  /** Clock override (tests). */
  readonly now?: () => number;
}

const DEFAULT_STREAK = 3;
const DEFAULT_STALE_MS = 48 * 60 * 60 * 1000;

/** Builds the `enrichment` component's `HealthProbe` (registered in `build-gateway.ts`). */
export function createEnrichmentHealthProbe(options: EnrichmentHealthOptions): HealthProbe {
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

    for (const vault of options.vaults()) {
      let rows: readonly EnrichmentAutomationRow[];
      try {
        rows = await vault.listAutomations();
      } catch {
        // Vault workspace not settled/mounted yet (fresh boot, or a plane
        // nothing has touched) — nothing to probe here; the `vaults`
        // component already flags a failed mount.
        continue;
      }
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
          if (latest.endedAt !== undefined && now() - latest.endedAt > staleAfterMs) {
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

    const enabledNote = `${enabledTotal} of ${installedTotal} enricher${installedTotal === 1 ? '' : 's'} enabled`;
    if (persistentlyFailing.length > 0) {
      return {
        status: 'error',
        detail: `${enabledNote} — persistently failing: ${persistentlyFailing.join(', ')}`,
      };
    }
    if (recentlyFailing.length > 0 || stale.length > 0) {
      const parts: string[] = [];
      if (recentlyFailing.length > 0) parts.push(`recent failure: ${recentlyFailing.join(', ')}`);
      if (stale.length > 0) parts.push(`stale: ${stale.join(', ')}`);
      return { status: 'degraded', detail: `${enabledNote} — ${parts.join('; ')}` };
    }
    return { status: 'ok', detail: enabledNote };
  };
}
