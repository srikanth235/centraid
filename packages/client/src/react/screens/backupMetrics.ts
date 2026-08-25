/*
 * Maps backup-status + usage DTOs onto one `deriveStorageMetrics` call
 * (#436 §6). Oldest vault wins each clock; a clock any vault never reached
 * is `null`. Declared cadence is the slowest of RPO/snapshot/verify.
 */

import type { StorageConnectionUsageDTO } from "../../gateway-client.js";
import { deriveStorageMetrics } from "../../storage-metrics.js";
import type {
  StorageMetrics,
  RetentionInput,
  UsageInput,
} from "../../storage-metrics.js";
import type { BackupStatusDTO, BackupVaultStatusDTO } from "./BackupCard.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseIso(iso: string | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/** Oldest non-null, or `null` if any vault is missing it. */
function oldestOrMissing(values: (number | null)[]): number | null {
  if (values.length === 0) return null;
  if (values.some((v) => v === null)) return null;
  return Math.min(...(values as number[]));
}

function vaultCadenceMs(vault: BackupVaultStatusDTO): number {
  const rpoSeconds = vault.policy?.rpoSeconds ?? 60;
  const snapshotIntervalHours = vault.policy?.snapshotIntervalHours ?? 24;
  const verifyEveryDays = vault.policy?.verifyEveryDays ?? 7;
  return Math.max(
    rpoSeconds * 1000,
    snapshotIntervalHours * HOUR_MS,
    verifyEveryDays * DAY_MS
  );
}

export interface LossSummary {
  tone: "unconfigured" | "unknown" | "safe" | "exposed";
  exposedMs: number | null;
  pendingBytes: number;
  pendingCount: number;
}

export function deriveLossSummary(
  status: BackupStatusDTO,
  metrics: StorageMetrics
): LossSummary {
  const configured =
    status.configured || status.vaults.some((v) => v.lastBackupAt);
  const pendingBytes = status.vaults.reduce(
    (sum, v) => sum + (v.pendingOffsite?.bytes ?? 0),
    0
  );
  const pendingCount = status.vaults.reduce(
    (sum, v) => sum + (v.pendingOffsite?.count ?? 0),
    0
  );
  if (!configured) {
    return {
      tone: "unconfigured",
      exposedMs: null,
      pendingBytes,
      pendingCount,
    };
  }
  // Pending offsite is a known loss — don't fold it into "unknown" just
  // because a nonzero pending count also blanks the outbox-drain clock.
  if (pendingBytes > 0) {
    return {
      tone: "exposed",
      exposedMs: metrics.freshness.ageMs,
      pendingBytes,
      pendingCount,
    };
  }
  if (
    metrics.freshness.status === "unknown" ||
    metrics.freshness.ageMs === null
  ) {
    return { tone: "unknown", exposedMs: null, pendingBytes, pendingCount };
  }
  const { ageMs, declaredCadenceMs } = metrics.freshness;
  return {
    tone: ageMs <= declaredCadenceMs ? "safe" : "exposed",
    exposedMs: ageMs,
    pendingBytes,
    pendingCount,
  };
}

export function aggregateUsage(
  connections: StorageConnectionUsageDTO[] | null
): UsageInput | null {
  if (!connections || connections.length === 0) return null;
  const out: UsageInput = {};
  let sawAny = false;
  for (const conn of connections) {
    const reported = conn.providerReported;
    if (!reported) continue;
    for (const store of ["backup", "cas", "derived"] as const) {
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

export function computeStorageMetrics(
  status: BackupStatusDTO,
  usage: UsageInput | null,
  now: number
): StorageMetrics {
  const vaults = status.vaults;
  const snapshotClocks = vaults.map((v) => parseIso(v.lastBackupAt));
  const verifyClocks = vaults.map((v) => parseIso(v.lastVerifyAt));
  const walClocks = vaults.map((v) => parseIso(v.lastWalDrainAt));
  // Outbox is drained only when nothing is pending; else the edge is unproven.
  const outboxClocks = vaults.map((v) =>
    (v.pendingOffsite?.count ?? 0) === 0 ? parseIso(v.lastWalDrainAt) : null
  );

  const declaredCadenceMs =
    vaults.length > 0 ? Math.max(...vaults.map(vaultCadenceMs)) : 7 * DAY_MS;

  const retention: RetentionInput = status.home?.retention ?? { kind: "none" };

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
    restoreCostClass: status.home?.restoreCostClass ?? "free-egress",
  });
}
