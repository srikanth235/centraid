/*
 * Maps the gateway's backup-status + storage-usage DTOs onto the ONE normative
 * five-metric derivation (`deriveStorageMetrics`, issue #436 §6) — computed a
 * single time here so the Backups health surface never re-derives a slightly
 * different story per readout. Pure and framework-free: given the same DTOs +
 * clock it always returns the same metrics.
 *
 * The four freshness clocks are aggregated across every mounted vault: for each
 * clock the OLDEST vault wins (min), and a clock any vault has never reached is
 * `null` — an unproven protection edge across the fleet can't be called fresh.
 * The declared cadence is the SLOWEST of the policies' three protection
 * cadences (RPO, snapshot, verify), so a fleet that is on-schedule for its
 * slowest promise still reads green rather than false-red on the oldest clock.
 */

import {
  deriveStorageMetrics,
  type StorageMetrics,
  type RetentionInput,
  type UsageInput,
} from '../../storage-metrics.js';
import type { BackupStatusDTO, BackupVaultStatusDTO } from './BackupCard.js';
import type { StorageConnectionUsageDTO } from '../../gateway-client.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseIso(iso: string | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/** The oldest non-null across a fleet, or `null` if ANY vault is missing it. */
function oldestOrMissing(values: (number | null)[]): number | null {
  if (values.length === 0) return null;
  if (values.some((v) => v === null)) return null;
  return Math.min(...(values as number[]));
}

/** One vault's declared protection cadence — the slowest of its three
 *  cadences, so the min-of-clocks freshness edge stays green when every clock
 *  is within its own schedule. Defaults mirror `DEFAULT_BACKUP_POLICY`. */
function vaultCadenceMs(vault: BackupVaultStatusDTO): number {
  const rpoSeconds = vault.policy?.rpoSeconds ?? 60;
  const snapshotIntervalHours = vault.policy?.snapshotIntervalHours ?? 24;
  const verifyEveryDays = vault.policy?.verifyEveryDays ?? 7;
  return Math.max(rpoSeconds * 1000, snapshotIntervalHours * HOUR_MS, verifyEveryDays * DAY_MS);
}

/** Sum provider-reported usage across every home connection into the aggregate
 *  per-store shape the cost metric reads. `null` before the first poll. */
export function aggregateUsage(connections: StorageConnectionUsageDTO[] | null): UsageInput | null {
  if (!connections || connections.length === 0) return null;
  const out: UsageInput = {};
  let sawAny = false;
  for (const conn of connections) {
    const reported = conn.providerReported;
    if (!reported) continue;
    for (const store of ['backup', 'cas', 'derived'] as const) {
      const report = reported[store];
      if (!report) continue;
      sawAny = true;
      const prev = out[store] ?? { bytesStored: 0, quotaBytes: null };
      out[store] = {
        bytesStored: prev.bytesStored + report.bytesStored,
        quotaBytes:
          report.quotaBytes === null
            ? prev.quotaBytes
            : Math.max(prev.quotaBytes ?? 0, report.quotaBytes),
      };
    }
  }
  return sawAny ? out : null;
}

/** The single normative five-metric derivation for the Backups health surface. */
export function computeStorageMetrics(
  status: BackupStatusDTO,
  usage: UsageInput | null,
  now: number,
): StorageMetrics {
  const vaults = status.vaults;
  const snapshotClocks = vaults.map((v) => parseIso(v.lastBackupAt));
  const verifyClocks = vaults.map((v) => parseIso(v.lastVerifyAt));
  const walClocks = vaults.map((v) => parseIso(v.lastWalDrainAt));
  // The outbox is only provably drained when nothing is pending offsite; its
  // watermark is then the newest WAL drain, else the edge is unproven (null).
  const outboxClocks = vaults.map((v) =>
    (v.pendingOffsite?.count ?? 0) === 0 ? parseIso(v.lastWalDrainAt) : null,
  );

  const declaredCadenceMs =
    vaults.length > 0 ? Math.max(...vaults.map(vaultCadenceMs)) : 7 * DAY_MS;

  const retention: RetentionInput = status.home?.retention ?? { kind: 'none' };

  return deriveStorageMetrics({
    now,
    freshness: {
      declaredCadenceMs,
      clocks: {
        lastRegisteredSnapshotAt: oldestOrMissing(snapshotClocks),
        lastSuccessfulVerificationAt: oldestOrMissing(verifyClocks),
        lastAckedWalSegmentAt: oldestOrMissing(walClocks),
        outboxDrainedWatermarkAt: oldestOrMissing(outboxClocks),
      },
    },
    retention,
    usage,
    restoreCostClass: status.home?.restoreCostClass ?? 'free-egress',
  });
}
