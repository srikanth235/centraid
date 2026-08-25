// CACHE MODEL (#405): the local tier is a BOUNDED SPOOL, not a full mirror.
// Tinies are pinned, replicated mediums are admission-evictable, originals are
// evictable ONLY by the post-reconciliation sweep. Admission never trusts a
// possibly stale replica-index row to delete an original's last local copy.

import { availableParallelism, totalmem } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import type { BackupPolicy } from "../backup-policy.js";
import { VaultBlobBackpressureError } from "../errors.js";
import {
  pendingOutboxShas,
  pinnedThumbShas,
  previewShas,
  stagingShas,
} from "./evict.js";
import type { LocalBlobStore } from "./local.js";
import { OrphanTombstoneIndex } from "./orphan-tombstone.js";
import { AccessIndex, ReplicaIndex } from "./replica-index.js";

export interface BlobCacheSettings {
  /** Explicit 0 is "unset", NOT "evict everything". */
  budgetBytes?: number;
}

export type BlobEvictionScope = "admission" | "reconciled-sweep";

export function readBlobCacheSettings(vault: DatabaseSync): BlobCacheSettings {
  try {
    const row = vault
      .prepare("SELECT settings_json FROM core_vault LIMIT 1")
      .get() as { settings_json: string | null } | undefined;
    if (!row?.settings_json) return {};
    const parsed = JSON.parse(row.settings_json) as Record<string, unknown>;
    const bag = parsed["blob_cache"];
    return bag && typeof bag === "object" ? (bag as BlobCacheSettings) : {};
  } catch {
    return {};
  }
}

export const CACHE_BUDGET_FLOOR_BYTES = 1 * 1024 ** 3; // 1 GiB
export const CACHE_BUDGET_CEILING_BYTES = 100 * 1024 ** 3; // 100 GiB
export const DEFAULT_REPLICATION_CONCURRENCY = 3;

export function replicationConcurrencyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  host?: { cores: number; totalMemoryBytes: number }
): number {
  const resolvedHost = host ?? {
    cores: availableParallelism(),
    totalMemoryBytes: totalmem(),
  };
  const fallback =
    resolvedHost.cores <= 4 || resolvedHost.totalMemoryBytes <= 4 * 1024 ** 3
      ? 1
      : 3;
  const raw = env.CENTRAID_REPLICATION_CONCURRENCY;
  if (raw === undefined || raw === "") return fallback;
  const parsed = Math.trunc(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 8) : fallback;
}
export const DEFAULT_QOS_COOLDOWN_MS = 500;
export const DEFAULT_QOS_POLL_MS = 25;

export interface CacheStatfs {
  bavail: number;
  bsize: number;
}

export interface BlobCacheOptions {
  /** Absent ⇒ no disk to measure, so the budget is UNLIMITED. */
  statfs?: () => CacheStatfs | null;
  settings?: () => BlobCacheSettings;
  policy?: () => BackupPolicy;
  replicationConcurrency?: number;
  qosCooldownMs?: number;
  qosPollMs?: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BlobMetrics {
  localHits: number;
  readThroughs: number;
  rangedRemoteReads: number;
  bytesServedLocal: number;
  bytesServedRemote: number;
  evictedBlobs: number;
  evictedBytes: number;
  backpressureEvents: number;
  spoolBytes: number;
  budgetBytes: number;
}

export class BlobCache {
  readonly replica: ReplicaIndex;
  readonly access: AccessIndex;
  readonly orphan: OrphanTombstoneIndex;
  private spool: number | null = null;

  private localHits = 0;
  private readThroughs = 0;
  private rangedRemoteReads = 0;
  private bytesServedLocal = 0;
  private bytesServedRemote = 0;
  private evictedBlobs = 0;
  private evictedBytes = 0;
  private backpressureEvents = 0;

  // Bulk replication parks while either is "hot" (#405).
  private interactiveReads = 0;
  private lastInteractiveAtMs = 0;

  readonly replicationConcurrency: number;
  private readonly qosCooldownMs: number;
  private readonly qosPollMs: number;
  private readonly nowMs: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly local: LocalBlobStore,
    private readonly options: BlobCacheOptions = {}
  ) {
    this.replica = new ReplicaIndex(db);
    this.access = new AccessIndex(db);
    this.orphan = new OrphanTombstoneIndex(db);
    this.replicationConcurrency =
      options.replicationConcurrency ?? replicationConcurrencyFromEnv();
    this.qosCooldownMs = options.qosCooldownMs ?? DEFAULT_QOS_COOLDOWN_MS;
    this.qosPollMs = options.qosPollMs ?? DEFAULT_QOS_POLL_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sleepFn =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** Initialized ONCE by a lazy scan, then adjusted purely on put/delete, so
   *  no query ever rescans. */
  spoolBytes(): number {
    if (this.spool === null) {
      let total = 0;
      for (const sha of this.local.listSync())
        total += this.local.statSync(sha)?.size ?? 0;
      this.spool = total;
    }
    return this.spool;
  }

  onPut(size: number): void {
    if (this.spool !== null) this.spool += size;
  }

  onDelete(size: number): void {
    if (this.spool !== null) this.spool = Math.max(0, this.spool - size);
  }

  onLocalHit(bytesServed: number): void {
    this.localHits += 1;
    this.bytesServedLocal += bytesServed;
  }
  onReadThrough(bytesServed: number): void {
    this.readThroughs += 1;
    this.bytesServedRemote += bytesServed;
  }
  onRangedRemote(bytesServed: number): void {
    this.rangedRemoteReads += 1;
    this.bytesServedRemote += bytesServed;
  }

  enterInteractive(): void {
    this.interactiveReads += 1;
  }
  exitInteractive(): void {
    this.interactiveReads = Math.max(0, this.interactiveReads - 1);
    this.lastInteractiveAtMs = this.nowMs();
  }
  async qosWait(): Promise<void> {
    const waitUntilClear = async (): Promise<void> => {
      const cooling =
        this.nowMs() - this.lastInteractiveAtMs < this.qosCooldownMs;
      if (this.interactiveReads === 0 && !cooling) return;
      await this.sleepFn(this.qosPollMs);
      return waitUntilClear();
    };
    return waitUntilClear();
  }

  freeBytes(): number | null {
    const stat = this.options.statfs?.();
    if (!stat) return null;
    return stat.bavail * stat.bsize;
  }

  /** An explicit `budgetBytes` wins; else half of what the volume could hold
   *  with the spool emptied, clamped so a tiny disk still gets a working set
   *  and a huge one is not eaten by this cache; else UNLIMITED. */
  budgetBytes(): number {
    const explicit =
      this.options.policy?.().cacheBudgetBytes ?? this.settings().budgetBytes;
    if (explicit && explicit > 0) return explicit;
    const free = this.freeBytes();
    if (free === null) return Number.MAX_SAFE_INTEGER;
    const half = Math.floor(0.5 * (free + this.spoolBytes()));
    return Math.max(
      CACHE_BUDGET_FLOOR_BYTES,
      Math.min(half, CACHE_BUDGET_CEILING_BYTES)
    );
  }

  private settings(): BlobCacheSettings {
    return this.options.settings?.() ?? readBlobCacheSettings(this.db);
  }

  isReplicated(sha: string): boolean {
    return this.replica.has(sha);
  }

  /** BOTH limits applied: a budget-only floor would claim "1 GiB available"
   *  on a volume with 100 MiB free. */
  admissionCapacity(
    reservedBytes = 0,
    diskReservedBytes = reservedBytes
  ): {
    availableBytes: number;
    freeBytes: number | null;
    reservedHeadroomBytes: number;
  } {
    const freeBytes = this.freeBytes();
    const reservedHeadroomBytes =
      this.options.policy?.().reservedHeadroomBytes ?? 0;
    const budgetAvailable = Math.max(
      0,
      this.budgetBytes() - this.spoolBytes() - reservedBytes
    );
    const diskAvailable =
      freeBytes === null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, freeBytes - reservedHeadroomBytes - diskReservedBytes);
    return {
      availableBytes: Math.min(budgetAvailable, diskAvailable),
      freeBytes,
      reservedHeadroomBytes,
    };
  }

  /** Un-replicated bytes are NEVER deleted, so a backlog that holds the space
   *  throws `VaultBlobBackpressureError` and the caller paces against the
   *  uplink instead of losing data. */
  admit(
    incoming: number,
    reservedBytes = 0,
    diskReservedBytes = reservedBytes
  ): void {
    const target = this.budgetBytes();
    if (
      this.admissionCapacity(reservedBytes, diskReservedBytes).availableBytes >=
      incoming
    )
      return;
    this.runEviction(incoming, reservedBytes, diskReservedBytes, "admission");
    const capacity = this.admissionCapacity(reservedBytes, diskReservedBytes);
    if (capacity.availableBytes < incoming) {
      this.backpressureEvents += 1;
      throw new VaultBlobBackpressureError(
        "blob ingest",
        `blob ingest needs ${incoming} bytes but only ${capacity.availableBytes} bytes are ` +
          `admissible (free=${capacity.freeBytes ?? "unknown"}, reserved headroom=${capacity.reservedHeadroomBytes}, ` +
          `cache spool=${this.spoolBytes()}, budget=${target}); nothing safely evictable`,
        {
          needBytes: incoming,
          availableBytes: capacity.availableBytes,
          freeBytes: capacity.freeBytes,
          reservedHeadroomBytes: capacity.reservedHeadroomBytes,
        }
      );
    }
  }

  /**
   * Admission may shed only reconstructible LRU previews; the post-reconciliation
   * scope may then shed LRU originals. That keeps STALE replica evidence from
   * authorizing an original's deletion before a deep remote listing has healed
   * it. Pinned, staged, pending-offsite and evidence-free blobs are unevictable.
   */
  runEviction(
    incoming = 0,
    reservedBytes = 0,
    diskReservedBytes = reservedBytes,
    scope: BlobEvictionScope = "admission"
  ): { evicted: string[]; bytes: number } {
    const target = this.budgetBytes();
    const free = this.freeBytes();
    const headroom = this.options.policy?.().reservedHeadroomBytes ?? 0;
    const logicalNeed = Math.max(
      0,
      this.spoolBytes() + reservedBytes + incoming - target
    );
    const physicalNeed =
      free === null
        ? 0
        : Math.max(0, headroom + diskReservedBytes + incoming - free);
    const bytesNeeded = Math.max(logicalNeed, physicalNeed);
    if (bytesNeeded === 0) return { evicted: [], bytes: 0 };
    this.access.flush();
    const localSet = new Set(this.local.listSync());
    const pinned = pinnedThumbShas(this.db);
    const staging = stagingShas(this.db);
    const pendingOutbox = pendingOutboxShas(this.db);
    const preview = previewShas(this.db);
    const evictable = (sha: string): boolean =>
      localSet.has(sha) &&
      this.replica.has(sha) &&
      !pinned.has(sha) &&
      !staging.has(sha) &&
      !pendingOutbox.has(sha);
    // Mediums first; originals only when the caller just reconciled the
    // replica index against remote truth.
    const previews = [...preview].filter(evictable);
    const originals =
      scope === "reconciled-sweep"
        ? [...localSet].filter((s) => evictable(s) && !preview.has(s))
        : [];
    const order = [
      ...this.access.orderOldestFirst(previews),
      ...this.access.orderOldestFirst(originals),
    ];
    const evicted: string[] = [];
    let bytes = 0;
    for (const sha of order) {
      if (bytes >= bytesNeeded) break;
      const freed = this.deleteReplicated(sha);
      if (freed > 0) {
        evicted.push(sha);
        bytes += freed;
      }
    }
    this.evictedBlobs += evicted.length;
    this.evictedBytes += bytes;
    return { evicted, bytes };
  }

  private deleteReplicated(sha: string): number {
    if (!this.replica.has(sha)) return 0;
    const size = this.local.statSync(sha)?.size ?? 0;
    this.local.deleteSync(sha);
    this.access.drop(sha);
    this.onDelete(size);
    return size;
  }

  metrics(): BlobMetrics {
    return {
      localHits: this.localHits,
      readThroughs: this.readThroughs,
      rangedRemoteReads: this.rangedRemoteReads,
      bytesServedLocal: this.bytesServedLocal,
      bytesServedRemote: this.bytesServedRemote,
      evictedBlobs: this.evictedBlobs,
      evictedBytes: this.evictedBytes,
      backpressureEvents: this.backpressureEvents,
      spoolBytes: this.spoolBytes(),
      budgetBytes: this.budgetBytes(),
    };
  }
}

export const EMPTY_BLOB_METRICS: BlobMetrics = {
  localHits: 0,
  readThroughs: 0,
  rangedRemoteReads: 0,
  bytesServedLocal: 0,
  bytesServedRemote: 0,
  evictedBlobs: 0,
  evictedBytes: 0,
  backpressureEvents: 0,
  spoolBytes: 0,
  budgetBytes: 0,
};
