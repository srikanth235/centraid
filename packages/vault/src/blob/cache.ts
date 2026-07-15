// The bounded storage tier's cache coordinator (issue #405 §3/§7) — budget
// evaluation, incremental spool accounting, the ordered eviction pass, the
// custody-layer evict PRIMITIVE that refuses to delete an un-replicated last
// copy, the ingest precheck, the process-lifetime metrics counters, and the
// QoS gate that lets interactive reads preempt bulk replication. `BlobCustody`
// (custody.ts) holds one of these when the host wires it and stays a thin
// facade over it; tests construct it directly over an in-memory vault handle.
//
// Cache model (supersedes the pre-#405 "local is ALWAYS complete" invariant):
// the local tier is now a BOUNDED spool, not a full mirror. Tinies are pinned;
// replicated mediums/originals are evictable LRU; `remote-only` blobs read
// through on demand (custody.open) and re-promote. The one hard rule: a
// `local-only` (un-replicated) blob's last copy is never deleted — not by the
// sweep, not by disk pressure — only backpressured (VaultBlobBackpressureError).

import type { DatabaseSync } from 'node:sqlite';
import { VaultBlobBackpressureError } from '../errors.js';
import type { LocalBlobStore } from './local.js';
import { AccessIndex, ReplicaIndex } from './replica-index.js';
import { pinnedThumbShas, previewShas, stagingShas } from './evict.js';

/** The `blob_cache` settings bag (issue #405 §3), camelCase to match `blob_store`. */
export interface BlobCacheSettings {
  /**
   * Hard spool budget in bytes. Unset ⇒ derived from disk free space (see
   * `budgetBytes`). Explicit 0 is treated as "unset" (fall to the derived
   * default) rather than "evict everything".
   */
  budgetBytes?: number;
}

/** The vault's current `blob_cache` settings (`{}`-safe on any shape). */
export function readBlobCacheSettings(vault: DatabaseSync): BlobCacheSettings {
  try {
    const row = vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as
      | { settings_json: string | null }
      | undefined;
    if (!row?.settings_json) return {};
    const parsed = JSON.parse(row.settings_json) as Record<string, unknown>;
    const bag = parsed['blob_cache'];
    return bag && typeof bag === 'object' ? (bag as BlobCacheSettings) : {};
  } catch {
    return {};
  }
}

/** Free-space floor: never let the derived budget drop below this. */
export const CACHE_BUDGET_FLOOR_BYTES = 1 * 1024 ** 3; // 1 GiB
/** Free-space ceiling: never let the derived budget grow past this. */
export const CACHE_BUDGET_CEILING_BYTES = 100 * 1024 ** 3; // 100 GiB
/** Default concurrent pushes per `replicate()` (issue #405 §4). */
export const DEFAULT_REPLICATION_CONCURRENCY = 3;
/** Default QoS cooldown after the last interactive read before bulk resumes (issue #405 §7). */
export const DEFAULT_QOS_COOLDOWN_MS = 500;
/** Default poll interval while replication is parked behind an interactive read. */
export const DEFAULT_QOS_POLL_MS = 25;

/** The subset of `fs.statfsSync` the budget derivation needs. */
export interface CacheStatfs {
  bavail: number;
  bsize: number;
}

export interface BlobCacheOptions {
  /**
   * Volume free-space probe for the derived budget (issue #405 §3). Returns
   * null (or is absent) ⇒ no disk to measure (a MemoryBlobStore vault): the
   * budget is UNLIMITED unless the settings set it explicitly. FsBlobStore
   * vaults pass a `() => fs.statfsSync(blobsDir)` closure.
   */
  statfs?: () => CacheStatfs | null;
  /** Read the settings budget; defaults to `readBlobCacheSettings(db)`. Injectable for tests. */
  settings?: () => BlobCacheSettings;
  /** Concurrent pushes per `replicate()` (default 3, issue #405 §4). */
  replicationConcurrency?: number;
  /** Cooldown ms after the last interactive read before bulk resumes (default 500). */
  qosCooldownMs?: number;
  /** Poll ms while replication is parked behind an interactive read (default 25). */
  qosPollMs?: number;
  /** Monotonic clock for QoS timing — injectable so tests need no real waits. */
  nowMs?: () => number;
  /** Sleep primitive for the QoS poll loop — injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Process-lifetime custody counters (issue #405 §7). Routes/UI are a later
 * wave; this is the shape they will read.
 */
export interface BlobMetrics {
  /** Reads served straight from the local tier (no remote touch). */
  localHits: number;
  /** Full remote read-throughs (a cold blob fetched + promoted). */
  readThroughs: number;
  /** Ranged remote reads (covering-frames only, deliberately NOT promoted). */
  rangedRemoteReads: number;
  /** Bytes served to callers from the local tier. */
  bytesServedLocal: number;
  /** Bytes served to callers from the remote tier. */
  bytesServedRemote: number;
  /** Blobs the eviction pass shed. */
  evictedBlobs: number;
  /** Bytes the eviction pass reclaimed. */
  evictedBytes: number;
  /** Ingests refused because nothing was safely evictable (backpressure, never loss). */
  backpressureEvents: number;
  /** Live spool occupancy in bytes. */
  spoolBytes: number;
  /** Effective cache budget in bytes. */
  budgetBytes: number;
}

export class BlobCache {
  readonly replica: ReplicaIndex;
  readonly access: AccessIndex;
  /** null until first read — then maintained incrementally (never rescanned). */
  private spool: number | null = null;

  // Process-lifetime counters (issue #405 §7).
  private localHits = 0;
  private readThroughs = 0;
  private rangedRemoteReads = 0;
  private bytesServedLocal = 0;
  private bytesServedRemote = 0;
  private evictedBlobs = 0;
  private evictedBytes = 0;
  private backpressureEvents = 0;

  // QoS state (issue #405 §7): interactive read-throughs in flight now, and
  // when the last finished — bulk replication parks while either is "hot".
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
    private readonly options: BlobCacheOptions = {},
  ) {
    this.replica = new ReplicaIndex(db);
    this.access = new AccessIndex(db);
    this.replicationConcurrency = options.replicationConcurrency ?? DEFAULT_REPLICATION_CONCURRENCY;
    this.qosCooldownMs = options.qosCooldownMs ?? DEFAULT_QOS_COOLDOWN_MS;
    this.qosPollMs = options.qosPollMs ?? DEFAULT_QOS_POLL_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // ---- spool accounting (issue #405 §3/§7) ----

  /**
   * Live spool occupancy. Initialized ONCE by scanning the local tier (a real
   * scan at 500 GB is expensive — so it happens lazily, at most once per
   * process), then adjusted purely on put/delete so no query ever rescans.
   */
  spoolBytes(): number {
    if (this.spool === null) {
      let total = 0;
      for (const sha of this.local.listSync()) total += this.local.statSync(sha)?.size ?? 0;
      this.spool = total;
    }
    return this.spool;
  }

  /** A newly-added local blob of `size` bytes — bump the spool counter. */
  onPut(size: number): void {
    if (this.spool !== null) this.spool += size;
  }

  /** A removed local blob of `size` bytes — decrement, clamped at 0. */
  onDelete(size: number): void {
    if (this.spool !== null) this.spool = Math.max(0, this.spool - size);
  }

  // ---- metrics increments (issue #405 §7), called from the custody facade ----

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

  // ---- QoS gate (issue #405 §7) ----

  /** Mark one interactive read-through in flight — bulk replication yields to it. */
  enterInteractive(): void {
    this.interactiveReads += 1;
  }
  /** One interactive read settled — stamp the cooldown clock. */
  exitInteractive(): void {
    this.interactiveReads = Math.max(0, this.interactiveReads - 1);
    this.lastInteractiveAtMs = this.nowMs();
  }
  /**
   * Park bulk replication while an interactive read is in flight, and for a
   * short cooldown after the last one. Coarse by design — gates at blob
   * boundaries, not mid-multipart. Resolves immediately when nothing is hot.
   */
  async qosWait(): Promise<void> {
    for (;;) {
      const cooling = this.nowMs() - this.lastInteractiveAtMs < this.qosCooldownMs;
      if (this.interactiveReads === 0 && !cooling) return;
      await this.sleepFn(this.qosPollMs);
    }
  }

  // ---- budget (issue #405 §3) ----

  private freeBytes(): number | null {
    const stat = this.options.statfs?.();
    if (!stat) return null;
    return stat.bavail * stat.bsize;
  }

  /**
   * The effective cache budget in bytes. Precedence:
   *   1. explicit `blob_cache.budgetBytes` (> 0) — the operator's word wins;
   *   2. else derived from disk free space:
   *        clamp( floor 1 GiB, 0.5 * (free + current spool), ceiling 100 GiB )
   *      — half of what the volume could hold if the spool were emptied,
   *      bounded so a tiny disk still gets a working set and a huge disk
   *      doesn't let one vault's cache eat the whole volume;
   *   3. else (no disk to measure — MemoryBlobStore) UNLIMITED.
   */
  budgetBytes(): number {
    const explicit = this.settings().budgetBytes;
    if (explicit && explicit > 0) return explicit;
    const free = this.freeBytes();
    if (free === null) return Number.MAX_SAFE_INTEGER;
    const half = Math.floor(0.5 * (free + this.spoolBytes()));
    return Math.max(CACHE_BUDGET_FLOOR_BYTES, Math.min(half, CACHE_BUDGET_CEILING_BYTES));
  }

  private settings(): BlobCacheSettings {
    return this.options.settings?.() ?? readBlobCacheSettings(this.db);
  }

  /** Durable evidence that `sha` sits on the remote tier (issue #405 §4). */
  isReplicated(sha: string): boolean {
    return this.replica.has(sha);
  }

  // ---- ingest precheck (issue #405 §5) ----

  /**
   * Make room for `incoming` bytes or refuse. Runs an eviction pass if the
   * spool would exceed budget; if that still can't get under budget (an
   * un-replicated backlog holds the space, and we NEVER delete un-replicated
   * bytes), throws `VaultBlobBackpressureError` so the caller paces against the
   * uplink instead of losing data. A no-op when already under budget.
   */
  admit(incoming: number): void {
    const target = this.budgetBytes();
    if (this.spoolBytes() + incoming <= target) return;
    this.runEviction(incoming);
    if (this.spoolBytes() + incoming > target) {
      this.backpressureEvents += 1;
      throw new VaultBlobBackpressureError(
        'blob ingest',
        `blob cache spool ${this.spoolBytes()} + ${incoming} exceeds budget ${target}; ` +
          `nothing safely evictable (un-replicated backlog) — pace ingest against the uplink`,
      );
    }
  }

  // ---- eviction (issue #405 §3) ----

  /**
   * The eviction pass. Sheds local bytes — strictly (a) LRU previews, then (b)
   * LRU originals — until spool + `incoming` is at or under budget, or nothing
   * safely evictable remains. Never touches a pinned tiny, a staged blob, or an
   * un-replicated blob (the primitive `evictOne` enforces the last itself).
   */
  runEviction(incoming = 0): { evicted: string[]; bytes: number } {
    const target = this.budgetBytes();
    if (this.spoolBytes() + incoming <= target) return { evicted: [], bytes: 0 };
    // Flush write-behind touches so LRU ordering reflects the latest reads.
    this.access.flush();
    const localSet = new Set(this.local.listSync());
    const pinned = pinnedThumbShas(this.db);
    const staging = stagingShas(this.db);
    const preview = previewShas(this.db);
    const evictable = (sha: string): boolean =>
      localSet.has(sha) && this.replica.has(sha) && !pinned.has(sha) && !staging.has(sha);
    // (a) mediums first, (b) then originals (everything local that is neither a
    // preview, a pinned thumb, nor staged).
    const previews = [...preview].filter(evictable);
    const originals = [...localSet].filter((s) => evictable(s) && !preview.has(s));
    const order = [
      ...this.access.orderOldestFirst(previews),
      ...this.access.orderOldestFirst(originals),
    ];
    const evicted: string[] = [];
    let bytes = 0;
    for (const sha of order) {
      if (this.spoolBytes() + incoming <= target) break;
      const freed = this.evictOne(sha);
      if (freed > 0) {
        evicted.push(sha);
        bytes += freed;
      }
    }
    this.evictedBlobs += evicted.length;
    this.evictedBytes += bytes;
    return { evicted, bytes };
  }

  /**
   * The custody-layer evict PRIMITIVE (issue #405 §3): delete one local copy —
   * but ONLY if the replication index holds durable evidence a remote copy
   * exists. This guard lives HERE, inside the primitive, not just in the policy
   * loop above, so no future caller (a new sweep, a disk-pressure hook) can ever
   * delete the last copy of a `local-only` blob by calling a lower-level delete.
   * Returns the bytes freed, or 0 if the blob was refused/absent.
   */
  evictOne(sha: string): number {
    if (!this.replica.has(sha)) return 0; // never delete an un-replicated last copy
    const size = this.local.statSync(sha)?.size ?? 0;
    this.local.deleteSync(sha);
    this.access.drop(sha);
    this.onDelete(size);
    return size;
  }

  /** The full process-lifetime metrics snapshot (issue #405 §7). */
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

/** The zeroed metrics a cache-less custody reports (issue #405 §7). */
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
