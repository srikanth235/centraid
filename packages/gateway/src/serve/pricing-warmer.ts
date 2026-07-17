/*
 * Pricing catalog warmer (issue #445).
 *
 * The app-engine pricing seam ships a committed LiteLLM snapshot so costing
 * works offline from process start. This warmer overlays a FRESH table: it
 * fetches LiteLLM's canonical catalog, filters it through the shared
 * `filterLiteLLM` (identical to the snapshot's build), and hands it to
 * `setPricingCatalog`. The filtered table is cached to disk beside
 * `model-catalog.json` so a restart is instantly current without a refetch,
 * mirroring the storage-usage poller's TTL + stale-while-revalidate contract.
 *
 * Failure is always non-fatal: a refused/oversized/timed-out fetch keeps the
 * last-good disk table, or the bundled snapshot — a price is never invented.
 */

import { filterLiteLLM, setPricingCatalog, type PricingCatalog } from '@centraid/app-engine';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
/** Refresh the disk table once it's older than this. Coarse by design. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** Upstream is ~1.6 MB; cap well above that but bounded so a bad URL can't OOM. */
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
  /** Disk cache path (`model-pricing.json`). Omit for in-memory-only refresh. */
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

  /**
   * Boot: seed the in-memory catalog from a fresh-enough disk cache, then kick
   * a background refresh when the cache is stale/absent. Never throws.
   *
   * The live network refresh is gated on a configured `cacheFile` — same
   * opt-in shape as the templates warmer's `remoteTemplatesUrl` (a host that
   * pins a persistence path opts into fresh pricing; a warmer with nowhere to
   * cache stands on the bundled snapshot and never touches the network, so
   * tests that build a gateway make no external calls).
   */
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

  /** Fetch + filter + overlay + persist. Concurrent calls collapse to one. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const models = await this.fetchFiltered();
      const count = Object.keys(models).length;
      if (count === 0) throw new Error('filter produced zero entries');
      setPricingCatalog(models);
      this.lastFetchedMs = this.now();
      await this.writeDisk({ fetchedAt: new Date(this.lastFetchedMs).toISOString(), models });
      this.logger?.info(`pricing catalog refreshed: ${count} models`);
    } catch (err) {
      // Keep last-good (disk table) or the bundled snapshot — never a guess.
      this.logger?.warn(
        `pricing catalog refresh failed: ${err instanceof Error ? err.message : String(err)}`,
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
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_BYTES) throw new Error(`catalog too large: ${declared} bytes`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('catalog too large');
      return filterLiteLLM(JSON.parse(text) as Record<string, unknown>);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readDisk(): Promise<DiskCache | undefined> {
    if (!this.cacheFile) return undefined;
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8')) as DiskCache;
      if (parsed?.models && Object.keys(parsed.models).length > 0) return parsed;
    } catch {
      // No cache yet / unreadable — fall through to the bundled snapshot.
    }
    return undefined;
  }

  private async writeDisk(cache: DiskCache): Promise<void> {
    if (!this.cacheFile) return;
    try {
      await mkdir(path.dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, `${JSON.stringify(cache)}\n`);
    } catch (err) {
      this.logger?.warn(
        `pricing catalog cache write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
