// Pricing warmer (#445): fetch LiteLLM, filter, overlay the snapshot,
// cache to disk — failure non-fatal, never invent a price.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { filterLiteLLM, setPricingCatalog } from "@centraid/server/engine";
import type { PricingCatalog } from "@centraid/server/engine";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** ~1.6 MB upstream; bounded so a bad URL can't OOM. */
const MAX_BYTES = 8 * 1024 * 1024;

interface DiskCache {
  fetchedAt: string;
  models: PricingCatalog;
}

interface WarmerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface PricingWarmerOptions {
  /** Disk cache path; omit for memory-only refresh. */
  cacheFile?: string;
  ttlMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  logger?: WarmerLogger;
}

export class PricingWarmer {
  private readonly cacheFile?: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: WarmerLogger;
  private refreshing = false;
  private lastFetchedMs = 0;

  constructor(opts: PricingWarmerOptions = {}) {
    if (opts.cacheFile) this.cacheFile = opts.cacheFile;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.logger) this.logger = opts.logger;
  }

  /** Seed from fresh-enough disk cache, background-refresh stale; never throws; no `cacheFile` → no network. */
  async boot(): Promise<void> {
    if (!this.cacheFile) return;
    const disk = await this.readDisk();
    if (disk) {
      setPricingCatalog(disk.models);
      this.lastFetchedMs = Date.parse(disk.fetchedAt) || 0;
    }
    if (this.now() - this.lastFetchedMs > this.ttlMs) {
      void this.refresh().catch(() => undefined);
    }
  }

  /** Fetch + filter + overlay + persist; collapses concurrent calls. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const models = await this.fetchFiltered();
      const count = Object.keys(models).length;
      if (count === 0) throw new Error("filter produced zero entries");
      setPricingCatalog(models);
      this.lastFetchedMs = this.now();
      await this.writeDisk({
        fetchedAt: new Date(this.lastFetchedMs).toISOString(),
        models,
      });
      this.logger?.info(`pricing catalog refreshed: ${count} models`);
    } catch (error) {
      // Keep last-good or bundled snapshot — never a guess.
      this.logger?.warn(
        `pricing catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.refreshing = false;
    }
  }

  private async fetchFiltered(): Promise<PricingCatalog> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(LITELLM_URL, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES)
        throw new Error(`catalog too large: ${declared} bytes`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error("catalog too large");
      return filterLiteLLM(JSON.parse(text) as Record<string, unknown>);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readDisk(): Promise<DiskCache | undefined> {
    if (!this.cacheFile) return undefined;
    try {
      const parsed = JSON.parse(
        await readFile(this.cacheFile, "utf8")
      ) as DiskCache;
      if (parsed?.models && Object.keys(parsed.models).length > 0)
        return parsed;
    } catch {
      // No/unreadable cache — fall through to the bundled snapshot.
    }
    return undefined;
  }

  private async writeDisk(cache: DiskCache): Promise<void> {
    if (!this.cacheFile) return;
    try {
      await mkdir(path.dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, `${JSON.stringify(cache)}\n`);
    } catch (error) {
      this.logger?.warn(
        `pricing catalog cache write failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
