/*
 * Per-vault scheduler liveness + missed-run visibility — the `scheduler`
 * health component (issue #351 tier 2/3).
 *
 * Two signals share one probe because they read the SAME persisted ledger
 * (`@centraid/automation`'s `SchedulerLedgerStore`, written every tick from
 * `InProcessScheduler`'s `onTick` hook — see `build-gateway.ts`):
 *
 *   - liveness: `lastTickAt` age vs. the expected minute-boundary cadence.
 *     A scheduler that has ticked before but has gone quiet for several
 *     periods is either wedged or the process is somehow not running its
 *     timers — worth a flag distinct from "the gateway is simply new".
 *   - missed windows: the cumulative count + latest entry the ledger has
 *     recorded (see `scheduler-ledger.ts`) — recorded, not retro-executed,
 *     so this is purely visibility.
 *
 * Deliberately never escalates past `degraded` — like the `connections`
 * probe it sits beside, a scheduler being behind schedule is actionable
 * information, not "the gateway is down" (that's `_gateway/info`'s job).
 */

import type { SchedulerLedgerSnapshot } from '@centraid/automation';
import type { HealthProbe } from './health-registry.js';

export interface SchedulerHealthVaultEntry {
  readonly vaultId: string;
  /** Synchronous read of the vault's persisted scheduler ledger. */
  readonly snapshot: () => SchedulerLedgerSnapshot;
}

export interface SchedulerHealthOptions {
  readonly vaults: () => readonly SchedulerHealthVaultEntry[];
  /** The scheduler's tick cadence. Defaults to 60s (the minute-boundary timer). */
  readonly periodMs?: number;
  /** How many periods of silence before liveness flips degraded. Defaults to 3. */
  readonly staleAfterPeriods?: number;
  /** Clock override (tests). */
  readonly now?: () => number;
}

/** Builds the `scheduler` component's `HealthProbe` (registered in `build-gateway.ts`). */
export function createSchedulerHealthProbe(options: SchedulerHealthOptions): HealthProbe {
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
      // Before the first tick ever lands for a vault (fresh boot; or an
      // automation-free vault whose scheduler nonetheless ticks — see
      // in-process-scheduler.ts) there is nothing to compare against yet.
      // Dormant schedulers deliberately stop ticking; the transition hook
      // resets the baseline before work is enabled again.
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
    if (stale.length > 0) notes.push(`tick stale: ${stale.join(', ')}`);
    if (missedTotal > 0) {
      notes.push(
        `${missedTotal} missed automation window${missedTotal === 1 ? '' : 's'} recorded` +
          (latest ? ` — latest ${latest.label}` : ''),
      );
    }
    if (notes.length === 0) {
      return {
        status: 'ok',
        detail: `${vaults.length} vault scheduler${vaults.length === 1 ? '' : 's'} healthy`,
      };
    }
    return { status: 'degraded', detail: notes.join('; ') };
  };
}
