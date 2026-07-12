/*
 * Storage quota watermark — the `storage-quota` health component (issue
 * #367 §D2). Mirrors `disk-health.ts`'s two-watermark shape, just reading a
 * provider-reported figure (`StoreUsageReport.quotaBytes`,
 * packages/backup/PROTOCOL.md § Usage) instead of a local `statfs` call.
 *
 * Only a `provider`-kind storage connection with a provider-reported
 * `quotaBytes` can ever go `degraded`/`error` here — a `byo-s3` connection
 * has no metering endpoint to report one (see `storage-usage.ts`), and a
 * provider that doesn't meter reports `quotaBytes: null` ("unmetered", per
 * PROTOCOL.md). Both read as `ok` with an honest "unmetered" detail rather
 * than a fabricated pass — there is genuinely nothing to watch.
 */

import type { UsageByStore } from '@centraid/backup';
import { formatBytes } from './disk-health.js';
import type { HealthProbe } from './health-registry.js';

/** Fraction of `quotaBytes` at which a store's usage flips to `degraded`. */
export const QUOTA_DEGRADED_AT = 0.8;
/** Fraction of `quotaBytes` at which a store's usage flips to `error`. */
export const QUOTA_ERROR_AT = 0.95;

const STORE_CLASSES = ['backup', 'cas'] as const;

export interface StorageQuotaConnectionEntry {
  readonly connectionId: string;
  readonly name: string;
  readonly kind: 'byo-s3' | 'provider';
}

export interface StorageQuotaHealthOptions {
  /** Every configured storage connection — filtered to `kind: 'provider'` internally. */
  readonly connections: () => Promise<readonly StorageQuotaConnectionEntry[]>;
  /** The cached provider-reported usage for one connection (issue #367 §D1's poller). */
  readonly usageFor: (connectionId: string) => Promise<{ providerReported: UsageByStore | null }>;
}

/** Builds the `storage-quota` component's `HealthProbe` (registered in `build-gateway.ts`). */
export function createStorageQuotaHealthProbe(options: StorageQuotaHealthOptions): HealthProbe {
  return async () => {
    const connections = (await options.connections()).filter((c) => c.kind === 'provider');
    if (connections.length === 0) {
      return { status: 'ok', detail: 'no provider-kind storage connections configured' };
    }

    const errors: string[] = [];
    const degraded: string[] = [];
    let meteredCount = 0;

    for (const conn of connections) {
      const { providerReported } = await options.usageFor(conn.connectionId);
      if (!providerReported) continue;
      for (const storeClass of STORE_CLASSES) {
        const report = providerReported[storeClass];
        if (!report || report.quotaBytes === null || report.quotaBytes === undefined) continue;
        meteredCount += 1;
        const pct = report.quotaBytes > 0 ? report.bytesStored / report.quotaBytes : 1;
        const note =
          `${conn.name}/${storeClass}: ${formatBytes(report.bytesStored)} of ` +
          `${formatBytes(report.quotaBytes)} (${Math.round(pct * 100)}%)`;
        if (pct >= QUOTA_ERROR_AT) errors.push(note);
        else if (pct >= QUOTA_DEGRADED_AT) degraded.push(note);
      }
    }

    if (errors.length > 0) return { status: 'error', detail: errors.join('; ') };
    if (degraded.length > 0) return { status: 'degraded', detail: degraded.join('; ') };
    if (meteredCount === 0) {
      return { status: 'ok', detail: 'unmetered — no provider-reported quota yet' };
    }
    return { status: 'ok', detail: `${meteredCount} metered store(s) within quota` };
  };
}
