/*
 * Provider usage polling (issue #367 §D1) — the gateway-side cache in front
 * of `centraid-storage-provider/1`'s optional Layer-1 `usage` capability
 * (`GET /v1/backup/vaults/:id/usage`, packages/backup/PROTOCOL.md § Usage;
 * `RemoteBackupProvider.usageReport()`).
 *
 * A `provider`-kind storage connection is the only kind this can report
 * for — a `byo-s3` connection has no metering endpoint at all (the owner's
 * own bucket, no account to ask); `GET storage/usage` (storage-routes.ts)
 * falls back to locally-computed custody byte counts for those, same as it
 * always has.
 *
 * The provider's usage endpoint is a real network call against an account
 * that bills for, or at least logs, API traffic — this deliberately never
 * polls on its own timer. Instead: cache-with-TTL + stale-while-refresh,
 * driven by whoever calls `usageFor()` (the `storage/usage` route, and the
 * `storage-quota` health probe). The FIRST read for a connection has
 * nothing cached yet and awaits the fetch inline; every read after that
 * returns the cached report immediately and — only once the cache is older
 * than `pollIntervalMs` (default 30 min) — kicks a background refresh that
 * the NEXT read picks up. A failed refresh keeps serving the last-known-good
 * report (with an `error` note attached) rather than blanking a number that
 * was true a moment ago.
 */

import { openRemoteBackupProvider, type UsageByStore } from '@centraid/backup';
import type { StorageConnectionStore } from './storage-connections.js';

/** Refresh a cached report once it's older than this. Real network traffic
 *  against the provider's account, so this stays coarse by design. */
const DEFAULT_POLL_MS = 30 * 60 * 1000;

export interface ProviderUsageResult {
  /** `null` for a byo-s3 connection, a provider connection with no CAS
   *  target minted yet, or a provider that doesn't offer the `usage`
   *  capability (its `/usage` route 404s/refuses — see `error` below). */
  providerReported: UsageByStore | null;
  /** ISO timestamp of the last successful poll, or `null` before the first one. */
  fetchedAt: string | null;
  /** Set when the most recent refresh attempt failed — `providerReported`/
   *  `fetchedAt` still carry the last-known-good report, if any. */
  error?: string;
}

interface CacheEntry {
  result: ProviderUsageResult;
  fetchedAtMs: number;
  refreshing: boolean;
}

export interface StorageUsagePollerOptions {
  storageConnections: StorageConnectionStore;
  /** Cache staleness before a background refresh fires. Default 30 min. */
  pollIntervalMs?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** Injectable `fetch` (tests point this at an in-process fake provider). */
  fetchImpl?: typeof fetch;
}

export class StorageUsagePoller {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly storageConnections: StorageConnectionStore;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: StorageUsagePollerOptions) {
    this.storageConnections = options.storageConnections;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl;
  }

  /** Cached report for one connection — see the module header for the
   *  stale-while-refresh contract. Safe to call for a byo-s3 connection id
   *  (resolves to `{providerReported: null, fetchedAt: null}`, no network). */
  async usageFor(connectionId: string): Promise<ProviderUsageResult> {
    const cached = this.cache.get(connectionId);
    if (!cached) return this.refresh(connectionId);
    const age = this.now() - cached.fetchedAtMs;
    if (age > this.pollIntervalMs && !cached.refreshing) {
      cached.refreshing = true;
      void this.refresh(connectionId).catch(() => undefined);
    }
    return cached.result;
  }

  /** Drop a connection's cache entry — called when a connection is deleted
   *  or its credentials rotate, so a stale report never outlives it. */
  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  private async refresh(connectionId: string): Promise<ProviderUsageResult> {
    const prior = this.cache.get(connectionId);
    let result: ProviderUsageResult;
    try {
      result = await this.fetchOne(connectionId);
    } catch (err) {
      result = {
        providerReported: prior?.result.providerReported ?? null,
        fetchedAt: prior?.result.fetchedAt ?? null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.cache.set(connectionId, { result, fetchedAtMs: this.now(), refreshing: false });
    return result;
  }

  private async fetchOne(connectionId: string): Promise<ProviderUsageResult> {
    const connection = await this.storageConnections.get(connectionId);
    if (!connection || connection.kind !== 'provider') {
      return { providerReported: null, fetchedAt: null };
    }
    // No CAS target minted yet (the connection has never been attached to a
    // vault's blob_store) — nothing to ask the provider about.
    if (!connection.targetId || !connection.baseUrl) {
      return { providerReported: null, fetchedAt: null };
    }
    const apiKey = await this.storageConnections.resolveProviderApiKey(connectionId);
    const provider = openRemoteBackupProvider({
      baseUrl: connection.baseUrl,
      apiKey,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (!provider.usageReport) {
      return { providerReported: null, fetchedAt: null };
    }
    const usage = await provider.usageReport(connection.targetId);
    return { providerReported: usage, fetchedAt: new Date(this.now()).toISOString() };
  }
}
