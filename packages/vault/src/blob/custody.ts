// Blob custody facade (#296, #405): a local spool+cache tier and an optional
// remote BlobStore that REPLICATES it. Eviction never removes the last
// local-only copy. Remote deletes are reconciliation's job, so a crash costs an
// orphan, never a dangling row. Remote objects seal under the vault DEK (#293),
// AAD `blob:<sha>`, keyed off the PLAINTEXT sha.

import { nowIso } from "../ids.js";
import {
  DEFAULT_REPLICATION_CONCURRENCY,
  EMPTY_BLOB_METRICS,
} from "./cache.js";
import type { BlobCache, BlobMetrics } from "./cache.js";
import { exportLocalTier } from "./custody-export.js";
import {
  localBlobPath,
  openLocalBlobStream,
  readLocalBlob,
} from "./custody-local-read.js";
import {
  fetchFrameDirectory,
  fetchRemoteRange,
  fetchRemoteWhole,
} from "./custody-read.js";
import { reconcileCustody } from "./custody-reconcile.js";
import { createRemoteBlobStream } from "./custody-remote-stream.js";
import { remoteEncryptionKey, storeForClass } from "./custody-types.js";
import type {
  CustodyState,
  RemoteTier,
  ReconcileResult,
  ReconcileOptions,
  BlobSweepStatus,
} from "./custody-types.js";
import type { LocalBlobStore } from "./local.js";
import type { ReplicaStore } from "./replica-index.js";
import { driveReplication } from "./replicate-driver.js";
import type { FrameDirectory } from "./seal-frames.js";
import { sealBlob, sealBlobStream, unsealBlob } from "./seal.js";
import { resolveWriteStore } from "./store-routing.js";
import { resolveRange, sha256OfBytes } from "./store.js";
import type { BlobRange, BlobStore } from "./store.js";

export { sealBlob, sealBlobStream, unsealBlob } from "./seal.js";
export type {
  CustodyState,
  RemoteTier,
  ReconcileResult,
  ReconcileOptions,
  BlobSweepStatus,
} from "./custody-types.js";
export {
  refreshCustodyState,
  custodyStateCounts,
  custodyStateByteCounts,
} from "./custody-state.js";

const STREAMING_REPLICATE_THRESHOLD_BYTES = 32 * 1024 * 1024;

export class BlobCustody {
  private lastSweepCompletedAt: string | null = null;
  private lastSweepAttemptedAt: string | null = null;
  private lastSweepError: string | null = null;
  private sweepConsecutiveFailures = 0;

  /** Single-flight (#405): concurrent `open()`s for one cold sha must produce
   *  ONE provider GET. Both maps clear on settle — never a cache. */
  private readonly wholeInflight = new Map<string, Promise<Buffer | null>>();
  private readonly dirInflight = new Map<
    string,
    Promise<FrameDirectory | null>
  >();

  constructor(
    readonly local: LocalBlobStore,
    /** Lazy: switching `blob_store` needs no reopen; null when local-only. */
    private readonly remoteTier: () => RemoteTier | null,
    /** Absent ⇒ no eviction; `statusFor`/`replicate` list the remote. */
    private readonly cache?: BlobCache,
    /** Absent ⇒ everything routes to `cas` (#425). */
    private readonly desiredStore?: (sha: string) => ReplicaStore
  ) {}

  private storeForRead(remote: RemoteTier, sha: string): BlobStore {
    return storeForClass(remote, this.cache?.replica.storeOf(sha) ?? "cas");
  }

  sweepStatus(): BlobSweepStatus {
    return {
      lastCompletedAt: this.lastSweepCompletedAt,
      lastAttemptedAt: this.lastSweepAttemptedAt,
      lastError: this.lastSweepError,
      consecutiveFailures: this.sweepConsecutiveFailures,
    };
  }

  ingestSync(bytes: Buffer): { sha256: string; byteSize: number } {
    const sha = sha256OfBytes(bytes);
    const existed = this.local.hasSync(sha);
    // A NEW blob passes the budget precheck (may evict, may throw).
    if (this.cache && !existed) this.cache.admit(bytes.length);
    this.local.putSync(sha, bytes);
    if (this.cache && !existed) this.cache.onPut(bytes.length);
    return { sha256: sha, byteSize: bytes.length };
  }

  hasSync(sha: string): boolean {
    return this.local.hasSync(sha);
  }

  localPathSync(sha: string): string | null {
    return localBlobPath(this.local, sha);
  }
  getSync(sha: string, range?: BlobRange): Buffer | null {
    return readLocalBlob(this.local, this.cache, sha, range);
  }
  statSync(sha: string): { size: number } | null {
    return this.local.statSync(sha);
  }
  openReadStreamSync(sha: string, range?: BlobRange) {
    return openLocalBlobStream(this.local, this.cache, sha, range);
  }

  openRemoteReadStream(sha: string, size: number, range?: BlobRange) {
    const remote = this.remoteTier();
    if (!remote) return null;
    return createRemoteBlobStream(
      remote,
      this.storeForRead(remote, sha),
      sha,
      size,
      range,
      this.cache,
      this.local
    );
  }

  async open(sha: string, range?: BlobRange): Promise<Buffer | null> {
    const localHit = this.local.getSync(sha, range);
    if (localHit) {
      if (this.cache) {
        this.cache.onLocalHit(localHit.length);
        this.cache.access.touch(sha);
      }
      return localHit;
    }
    const remote = this.remoteTier();
    if (!remote) return null;
    const encryptionKey = remoteEncryptionKey(remote, sha);
    const store = this.storeForRead(remote, sha);
    this.cache?.enterInteractive();
    try {
      if (range && encryptionKey) {
        const dir = await this.readDirectory(store, sha, encryptionKey);
        if (!dir) return null;
        const sliced = await fetchRemoteRange(
          store,
          encryptionKey,
          sha,
          range,
          dir
        );
        if (sliced) this.cache?.onRangedRemote(sliced.length);
        return sliced;
      }

      const plain = await this.readWhole(remote, store, sha);
      if (plain === null) return null;
      if (!range) return plain;
      const resolved = resolveRange(plain.length, range);
      return resolved ? plain.subarray(resolved.start, resolved.end + 1) : null;
    } finally {
      this.cache?.exitInteractive();
    }
  }

  private readWhole(
    remote: RemoteTier,
    store: BlobStore,
    sha: string
  ): Promise<Buffer | null> {
    const existing = this.wholeInflight.get(sha);
    if (existing) return existing;
    const started = (async () => {
      const plain = await fetchRemoteWhole(
        store,
        remoteEncryptionKey(remote, sha),
        sha,
        unsealBlob
      );
      if (plain === null) return null;
      if (sha256OfBytes(plain) !== sha) {
        throw new Error(`remote blob ${sha} failed content verification`);
      }
      // A promote is not an ingest; it bypasses the budget precheck (#405).
      const existed = this.local.hasSync(sha);
      this.local.putSync(sha, plain);
      if (this.cache) {
        this.cache.onReadThrough(plain.length);
        if (!existed) this.cache.onPut(plain.length);
        this.cache.access.touch(sha, plain.length);
      }
      return plain;
    })();
    this.wholeInflight.set(sha, started);
    return started.finally(() => this.wholeInflight.delete(sha));
  }

  private readDirectory(
    store: BlobStore,
    sha: string,
    key: Buffer
  ): Promise<FrameDirectory | null> {
    const existing = this.dirInflight.get(sha);
    if (existing) return existing;
    const started = fetchFrameDirectory(store, key, sha);
    this.dirInflight.set(sha, started);
    return started.finally(() => this.dirInflight.delete(sha));
  }

  /** Does NOT unmark the replication index: deleted-but-replicated is
   *  legitimately `remote-only`. */
  deleteLocalSync(sha: string): void {
    const size = this.cache ? (this.local.statSync(sha)?.size ?? 0) : 0;
    this.local.deleteSync(sha);
    if (this.cache) {
      this.cache.onDelete(size);
      this.cache.access.drop(sha);
    }
  }

  async deleteEverywhere(sha: string): Promise<void> {
    const size = this.cache ? (this.local.statSync(sha)?.size ?? 0) : 0;
    this.local.deleteSync(sha);
    if (this.cache) {
      this.cache.onDelete(size);
      this.cache.access.drop(sha);
      this.cache.replica.unmark(sha);
    }
    const remote = this.remoteTier();
    if (remote) await remote.store.delete(sha);
  }

  /** The caller MUST first heal replica evidence from remote truth; only this
   *  scope sheds originals (#405). */
  evictAfterReconcile(): { evictedBlobs: number; evictedBytes: number } {
    if (!this.cache) return { evictedBlobs: 0, evictedBytes: 0 };
    const { evicted, bytes } = this.cache.runEviction(
      0,
      0,
      0,
      "reconciled-sweep"
    );
    return { evictedBlobs: evicted.length, evictedBytes: bytes };
  }

  metrics(): BlobMetrics {
    return this.cache?.metrics() ?? EMPTY_BLOB_METRICS;
  }

  /** Performs ZERO remote `list()` calls: steady-state replication must not list
   *  (#405). */
  async replicate(shas?: string[]): Promise<string[]> {
    const remote = this.remoteTier();
    if (!remote) return [];
    const want = shas ?? this.local.listSync();
    const alreadyThere = this.cache
      ? this.cache.replica.all()
      : new Set(await remote.store.list());
    return driveReplication({
      want,
      alreadyThere,
      pushOne: (sha) => this.pushOne(remote, sha),
      concurrency:
        this.cache?.replicationConcurrency ?? DEFAULT_REPLICATION_CONCURRENCY,
      qosWait: this.cache
        ? () => this.cache!.qosWait()
        : () => Promise.resolve(),
    });
  }

  private async pushOne(remote: RemoteTier, sha: string): Promise<boolean> {
    const landed = await this.replicateOne(remote, sha);
    if (landed && this.cache) {
      this.cache.replica.mark(sha, this.local.statSync(sha)?.size ?? 0, landed);
    }
    return landed !== null;
  }

  /** Returns where the bytes landed, or `null` when the local tier raced a
   *  delete — nothing to push, not an error. */
  private async replicateOne(
    remote: RemoteTier,
    sha: string
  ): Promise<ReplicaStore | null> {
    const encryptionKey = remoteEncryptionKey(remote, sha);
    const desired = this.desiredStore?.(sha) ?? "cas";
    const byteSize = this.local.statSync(sha)?.size ?? 0;
    const { store, storeClass } = resolveWriteStore(remote, desired, byteSize);
    const storageClass = remote.storageClassFor?.(sha, storeClass);
    const threshold =
      remote.streamThresholdBytes ?? STREAMING_REPLICATE_THRESHOLD_BYTES;
    const openStream = this.local.openReadStreamSync?.bind(this.local);
    if (openStream && store.putStream) {
      const opened = openStream(sha);
      if (opened) {
        if (opened.size < threshold) {
          // Small blobs fall through to the buffered path below.
        } else {
          const source = encryptionKey
            ? opened.stream.pipe(
                sealBlobStream(
                  encryptionKey,
                  sha,
                  opened.size,
                  remote.frameSize
                )
              )
            : opened.stream;
          await store.putStream(sha, source, opened.size, storageClass);
          return storeClass;
        }
      } else {
        return null; // local tier raced a delete out from under us
      }
    }
    const bytes = this.local.getSync(sha);
    if (!bytes) return null;
    await store.put(
      sha,
      encryptionKey
        ? sealBlob(encryptionKey, sha, bytes, remote.frameSize)
        : bytes,
      storageClass
    );
    return storeClass;
  }

  /** Shas absent from BOTH tiers are reported, never invented (#296). */
  async reconcile(
    liveShas: Set<string>,
    options: ReconcileOptions = {}
  ): Promise<ReconcileResult> {
    this.lastSweepAttemptedAt = nowIso();
    try {
      // The deep pass DOES list every granted store, healing the index (#405).
      const result = await reconcileCustody(
        {
          remote: this.remoteTier(),
          local: this.local,
          ...(this.cache ? { cache: this.cache } : {}),
          ...(this.cache ? { orphans: this.cache.orphan } : {}),
          desiredStore: (sha) => this.desiredStore?.(sha) ?? "cas",
          open: (sha) => this.open(sha),
          replicate: (shas) => this.replicate(shas),
        },
        liveShas,
        options
      );
      this.lastSweepCompletedAt = nowIso();
      this.lastSweepError = null;
      this.sweepConsecutiveFailures = 0;
      return result;
    } catch (error) {
      this.lastSweepError =
        error instanceof Error ? error.message : String(error);
      this.sweepConsecutiveFailures += 1;
      throw error;
    }
  }

  /** The remote tier resolves BEFORE the first await, so callers may close the
   *  vault handles immediately. */
  purgeRemote(): Promise<string[]> {
    const remote = this.remoteTier();
    if (!remote) return Promise.resolve([]);
    return (async () => {
      const shas = await remote.store.list();
      await Promise.all(
        shas.map(async (sha) => {
          await remote.store.delete(sha);
          this.cache?.replica.unmark(sha);
        })
      );
      return shas;
    })();
  }

  async statusFor(shas: Iterable<string>): Promise<Map<string, CustodyState>> {
    const remote = this.remoteTier();
    // Consult the replication INDEX, not a live `remote.list()`: a listing is
    // 100+ round trips per sweep at 500 GB (#405).
    const remoteShas = this.cache
      ? this.cache.replica.all()
      : remote
        ? new Set(await remote.store.list())
        : null;
    const out = new Map<string, CustodyState>();
    for (const sha of shas) {
      const local = this.local.hasSync(sha);
      const remoteHas = remoteShas?.has(sha) ?? false;
      if (remoteShas === null) {
        out.set(sha, local ? "local-only" : "missing");
      } else if (local && remoteHas) {
        out.set(sha, "replicated");
      } else if (local) {
        out.set(sha, "local-only");
      } else if (remoteHas) {
        out.set(sha, "remote-only");
      } else {
        out.set(sha, "missing");
      }
    }
    return out;
  }

  exportTo(destDir: string): { copied: number } {
    return exportLocalTier(this.local, destDir);
  }
}
