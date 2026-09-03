import type { UsageByStore } from "@centraid/backup";

import { formatBytes } from "./disk-health.js";
import type { HealthProbe } from "./health-registry.js";

export const QUOTA_DEGRADED_AT = 0.8;
export const QUOTA_ERROR_AT = 0.95;

const STORE_CLASSES = ["backup", "cas"] as const;

export interface StorageQuotaConnectionEntry {
  readonly connectionId: string;
  readonly name: string;
  readonly kind: "provider";
}

export interface StorageQuotaHealthOptions {
  readonly connections: () => Promise<readonly StorageQuotaConnectionEntry[]>;
  readonly usageFor: (
    connectionId: string
  ) => Promise<{ providerReported: UsageByStore | null }>;
}

export function createStorageQuotaHealthProbe(
  options: StorageQuotaHealthOptions
): HealthProbe {
  return async () => {
    const connections = (await options.connections()).filter(
      (c) => c.kind === "provider"
    );
    if (connections.length === 0) {
      return {
        status: "ok",
        detail: "no provider-kind storage connections configured",
      };
    }

    const errors: string[] = [];
    const degraded: string[] = [];
    let meteredCount = 0;

    const usage = await Promise.all(
      connections.map(async (conn) => ({
        conn,
        providerReported: (await options.usageFor(conn.connectionId))
          .providerReported,
      }))
    );
    for (const { conn, providerReported } of usage) {
      if (!providerReported) continue;
      for (const storeClass of STORE_CLASSES) {
        const report = providerReported[storeClass];
        if (
          !report ||
          report.quotaBytes === null ||
          report.quotaBytes === undefined
        )
          continue;
        meteredCount += 1;
        const pct =
          report.quotaBytes > 0 ? report.bytesStored / report.quotaBytes : 1;
        const note =
          `${conn.name}/${storeClass}: ${formatBytes(report.bytesStored)} of ` +
          `${formatBytes(report.quotaBytes)} (${Math.round(pct * 100)}%)`;
        if (pct >= QUOTA_ERROR_AT) errors.push(note);
        else if (pct >= QUOTA_DEGRADED_AT) degraded.push(note);
      }
    }

    if (errors.length > 0)
      return { status: "error", detail: errors.join("; ") };
    if (degraded.length > 0)
      return { status: "degraded", detail: degraded.join("; ") };
    if (meteredCount === 0) {
      return {
        status: "ok",
        detail: "unmetered — no provider-reported quota yet",
      };
    }
    return {
      status: "ok",
      detail: `${meteredCount} metered store(s) within quota`,
    };
  };
}
