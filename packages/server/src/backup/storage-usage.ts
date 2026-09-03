import { openRemoteBackupProvider } from "@centraid/backup";
import type { UsageByStore } from "@centraid/backup";

import type { StorageConnectionStore } from "./storage-connections.js";

const DEFAULT_POLL_MS = 30 * 60 * 1000;

export interface ProviderUsageResult {
  providerReported: UsageByStore | null;
  fetchedAt: string | null;
  error?: string;
}

interface CacheEntry {
  result: ProviderUsageResult;
  fetchedAtMs: number;
  refreshing: boolean;
}

export interface StorageUsagePollerOptions {
  storageConnections: StorageConnectionStore;
  pollIntervalMs?: number;
  now?: () => number;
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

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  private async refresh(connectionId: string): Promise<ProviderUsageResult> {
    const prior = this.cache.get(connectionId);
    let result: ProviderUsageResult;
    try {
      result = await this.fetchOne(connectionId);
    } catch (error) {
      result = {
        providerReported: prior?.result.providerReported ?? null,
        fetchedAt: prior?.result.fetchedAt ?? null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.cache.set(connectionId, {
      result,
      fetchedAtMs: this.now(),
      refreshing: false,
    });
    return result;
  }

  private async fetchOne(connectionId: string): Promise<ProviderUsageResult> {
    const connection = await this.storageConnections.get(connectionId);
    if (!connection || connection.kind !== "provider") {
      return { providerReported: null, fetchedAt: null };
    }
    if (!connection.targetId || !connection.baseUrl) {
      return { providerReported: null, fetchedAt: null };
    }
    const apiKey =
      await this.storageConnections.resolveProviderApiKey(connectionId);
    const provider = openRemoteBackupProvider({
      baseUrl: connection.baseUrl,
      apiKey,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (!provider.usageReport) {
      return { providerReported: null, fetchedAt: null };
    }
    const usage = await provider.usageReport(connection.targetId);
    return {
      providerReported: usage,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }
}
