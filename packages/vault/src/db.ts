// The physical layout from §03, extended by issue #296: vault.db holds all
// eleven schemas (model rows, engine-enforced FKs, one ACID boundary);
// journal.db holds the append-only audit stream (receipts, provenance,
// invocations, checks, evidence, explanations) PLUS the runtime's
// conversation-ledger band (the old standalone transcripts.db folded in —
// see journal.ts for the band split); and the `blobs/` sibling holds
// content-addressed bytes for everything that is not inline text
// (issue #296 — export = copy two files and a directory, verify hashes).
//
// Only the gateway holds these handles — apps, agents and generated views
// never see a connection (§10). Everything outside this package should go
// through createGateway().

import { mkdirSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BlobCustody, type RemoteTier } from './blob/custody.js';
import { BlobCache, readBlobCacheSettings } from './blob/cache.js';
import { BlobContentKeyRegistry } from './blob/content-keys.js';
import { FsBlobStore, MemoryBlobStore, type LocalBlobStore } from './blob/local.js';
import type { PreviewCodec } from './blob/preview.js';
import { S3BlobStore, type S3BlobStoreOptions, type S3Credentials } from './blob/s3.js';
import { S3TransferStore } from './blob/s3-transfer.js';
import { desiredStoreForSha, storageClassForShaWrite } from './blob/store-routing.js';
import { BlobTransferCoordinator } from './blob/transfers.js';
import { readBackupPolicy } from './backup-policy.js';
import { registerHammingFn } from './enrich/similarity.js';
import { asVaultDiskFullError } from './errors.js';
import { initializeReplicaProtocol } from './replica/change-log.js';
import { repairReplicaInvocationCommits } from './replica/invocation-commits.js';
import { registerContentTextFn } from './schema/fts.js';
import { JOURNAL_MIGRATIONS, migrate, VAULT_MIGRATIONS } from './schema/migrate.js';
import { ephemeralSealKey, resolveSealKey, sealKeyFileFor } from './schema/sealed.js';

export interface VaultDb {
  vault: DatabaseSync;
  journal: DatabaseSync;
  /** Directory holding vault.db + journal.db, or ':memory:'. */
  dir: string;
  /**
   * The vault's data-encryption key for sealed columns (issue #293). On-disk
   * vaults load-or-create it in the `keys/` sibling of the vault directory —
   * outside anything export/backup/copy moves, so a copied vault carries
   * ciphertext only. In-memory vaults get an ephemeral key.
   */
  sealKey: Buffer;
  /**
   * Blob custody (issue #296): the always-present local CAS plus the
   * settings-declared remote tier. The remote resolves lazily from
   * `core_vault.settings_json.blob_store` on every use, so switching
   * backends needs no reopen.
   */
  blobs: BlobCustody;
  /**
   * The settings-declared remote CAS tier, resolved fresh on every call from
   * the SAME cached closure `blobs`/`blobTransfers` use (issue #439 R2). A
   * lazy-by-default restore asks this "does the vault have a durable remote CAS
   * tier?" so the gateway can prefer the previews-first lazy path WITHOUT
   * rebuilding S3 config from settings + credentials by hand. `null` when the
   * vault has no s3-kind `blob_store` or no resolvable credential — the signal
   * to fall back to a FULL restore (the snapshot is the only copy). Constructing
   * the tier makes no network call; only a store operation does.
   */
  remote(): RemoteTier | null;
  /** Persistent resumable ingress + continuous pending-offsite drain (#414). */
  blobTransfers: BlobTransferCoordinator;
  /**
   * The preview ladder's raster codec (issue #405 §2), or undefined when no
   * codec is wired (the vault package carries none of its own). The gateway
   * host injects its jpeg-js/pngjs implementation here so the blob sweep's
   * preview backstop (gateway.ts `sweepBlobs` → `backfillPreviews`) can fill
   * missing tiny/medium derivatives for imported / weak-client / server-side
   * image originals. Absent = no backstop; capable clients still produce
   * their own rungs at capture time.
   */
  previewCodec?: PreviewCodec;
  /**
   * `skipOptimize` is for the WAL-shipper shutdown path (issue #408): the
   * shipper runs `PRAGMA optimize` itself BEFORE its final checkpoint, so
   * that optimize's ANALYZE writes don't sit in the WAL at handle close,
   * where SQLite's close-checkpoint would fold them into the main file
   * behind the shipper's back (a spurious foreign-checkpoint detection on
   * every restart).
   */
  close(opts?: { skipOptimize?: boolean }): void;
}

/** The `blob_store` settings bag shape (issue #296 §2, extended #367). */
export interface BlobStoreSettings {
  kind?: 'fs' | 's3';
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  /**
   * Key prefix for the target's `derived` store grant (issue #425 Wave 2),
   * stamped by the gateway when the provider advertises + grants the `derived`
   * store. Pairwise-disjoint from `prefix` (cas) and the backup prefix. Present
   * ⇒ `remoteTier()` builds a second `S3BlobStore` here and binary derivatives
   * (thumb/preview/poster) replicate under it; absent ⇒ graceful degradation,
   * derivatives stay under `prefix` (cas), byte-for-byte today's behavior.
   */
  derivedPrefix?: string;
  /** Legacy settings field. Remote CAS encryption is mandatory in v0. */
  encrypt?: boolean;
  /**
   * The gateway-level `storage-connections` entity (#367 §C1) this vault's
   * remote tier resolves credentials from. When set, `s3Credentials` is
   * expected to resolve creds keyed off this id (a short-lived
   * `requestCasGrant` against the provider). Absent = the legacy
   * harness-ambient env-var lane (`VaultPlaneOptions`'s default
   * `s3Credentials`).
   */
  connectionId?: string;
  /**
   * Denormalized copy of the connection's kind, stamped by the gateway
   * whenever it wires `connectionId` (issue #367 §C4). Only `provider`
   * connections exist now (#436 §2); all remote CAS objects use CBSF.
   */
  connectionKind?: 'provider';
  /**
   * Upload rate cap for the replication path, bytes/sec (issue #367 §C7,
   * simple token bucket in `S3BlobStore`). Omitted/0 = unthrottled.
   */
  throttleBytesPerSec?: number;
  /**
   * S3 storage class for object-creating writes (issue #405 §6) — passed
   * straight to `S3BlobStore` as `x-amz-storage-class` on PUT and
   * CreateMultipartUpload. camelCase in the settings JSON to match
   * `throttleBytesPerSec` (the bag is cast 1:1 from JSON, so the wire key and
   * this field are the same string). Free-form: S3-compatibles define their
   * own class names, so no enum is enforced here. Omitted ⇒ no header ⇒
   * today's behavior.
   */
  storageClass?: string;
  /**
   * Storage classes the target declared it supports (issue #425 Wave 3),
   * stamped by the gateway from provider discovery (`ProviderCapabilities.
   * storageClasses`) at attach time. The direct-to-cold heuristic only engages
   * when this includes `STANDARD_IA`; a BYO-S3 target has no discovery so the
   * field is absent and the heuristic never fires. Free-form provider-defined
   * class names, not an enum.
   */
  supportedStorageClasses?: string[];
}

export interface OpenVaultOptions {
  /** Directory for vault.db + journal.db. Omit for in-memory (tests). */
  dir?: string;
  /** Override the seal key (custody managed by the caller). */
  sealKey?: Buffer;
  /** Override the local blob tier (tests inject a MemoryBlobStore). */
  blobStore?: LocalBlobStore;
  /**
   * How S3 credentials resolve (issue #296 §2): the host wires this to the
   * broker/sealed-secret path (#290/#293) — creds never live in settings.
   * Without a resolver, an s3-configured vault stays local-only and the
   * replication sweep reports the gap instead of failing writes. The optional
   * `store` argument (issue #425 Wave 2) lets the host mint a store-scoped grant
   * — `cas` for the primary store, `derived` for the derivatives prefix — so a
   * provider that issues per-store credentials authorizes each store correctly;
   * a resolver that ignores it (own-S3, tests) simply returns the same creds.
   */
  s3Credentials?: (
    settings: BlobStoreSettings,
    store?: 'cas' | 'derived',
  ) => Promise<S3Credentials>;
  /**
   * The preview ladder's raster codec (issue #405 §2) — the gateway host
   * passes its jpeg-js/pngjs implementation so the blob sweep's backstop can
   * generate missing thumb/preview derivatives. Omitted for hosts (and tests)
   * with no codec: the backstop simply doesn't run.
   */
  previewCodec?: PreviewCodec;
  /** Host-wide pressure gate for detached replication and other maintenance. */
  shouldDeferBackgroundWork?: () => boolean;
  /** Hardware-profile cap for concurrent remote blob pushes. */
  replicationConcurrency?: number;
  /** FULL by default; a measured low-end hardware profile may choose WAL-safe NORMAL. */
  synchronous?: 'FULL' | 'NORMAL';
}

function openFile(location: string, synchronous: 'FULL' | 'NORMAL' = 'FULL'): DatabaseSync {
  try {
    const db = new DatabaseSync(location);
    db.exec('PRAGMA foreign_keys = ON');
    if (location !== ':memory:') {
      // auto_vacuum=INCREMENTAL bounds journal.db (issue #438): the ledger-band
      // archival prune (and #367's audit-band archival) frees pages that only
      // `incremental_vacuum` returns to the OS — freelist mode never shrinks the
      // file. MUST be set BEFORE journal_mode=WAL: on a fresh file the setting is
      // pending until the first table is created, but once WAL writes page 1 the
      // header is fixed and the pragma no longer takes at table-create time —
      // only a full VACUUM can then convert. So set it first (applies at DDL on
      // fresh files), then WAL.
      db.exec('PRAGMA page_size = 8192');
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      db.exec('PRAGMA journal_mode = WAL');
      // This is a personal-data vault with a low write rate — durability of
      // each commit matters more than write throughput, so fsync on every
      // transaction (WAL's default NORMAL can drop the last commit(s) on
      // power loss; FULL fsyncs the WAL on every commit).
      db.exec(`PRAGMA synchronous = ${synchronous}`);
      // Read-path tuning for Pi-class hosts (issue #456 S1). The negative
      // cache size is kibibytes, so this caps each connection at 16 MiB
      // instead of SQLite's ~2 MiB default. mmap is virtual and demand-paged;
      // 64 MiB keeps the address-space win without assuming desktop RAM.
      db.exec('PRAGMA cache_size = -16000');
      db.exec('PRAGMA mmap_size = 67108864');
      db.exec('PRAGMA temp_store = MEMORY');
      // journal.db also carries the conversation-ledger band (the old
      // transcripts.db folded in), which worker subprocesses open by path —
      // wait for their locks instead of failing immediately.
      db.exec('PRAGMA busy_timeout = 30000');
      // Checkpointing is the WAL shipper's exclusive duty (issue #408): segments
      // are raw WAL byte ranges, valid only while the WAL is strictly
      // append-only between checkpoints THE SHIPPER performs (TRUNCATE-only —
      // PASSIVE/RESTART reuse byte offsets in place). This pragma is a
      // PERFORMANCE HINT, not a correctness requirement (issue #411 action 1):
      // correctness rests on the shipper VERIFYING salts/offsets/main-file
      // identity at every capture and breaking the generation on any foreign
      // checkpoint — a stray autocheckpointing connection is caught and healed,
      // never a silent gap. What the pragma buys is keeping that healing rare:
      // each heal is a whole-DB base re-upload, so turning autocheckpoint OFF on
      // every connection — here and in every by-path opener (app-engine's
      // openJournalDb, key-admin) — keeps generation churn near zero.
      db.exec('PRAGMA wal_autocheckpoint = 0');
      // One-time conversion for a file created BEFORE #438 (auto_vacuum=0,
      // freelist mode) while fleet files are still small. A fresh file reads
      // back 2 here (the pragma above is pending, page 1 already written by WAL);
      // only a pre-existing NON-empty file still reads 0 — that is the migration
      // target. The pragma above already set INCREMENTAL as the VACUUM target, so
      // a single full VACUUM rewrites the file into incremental mode. Runs at
      // open with no transaction held and no other connection on the file yet, so
      // the "VACUUM cannot run inside a transaction / mid-write" constraints hold.
      // The WAL shipper (issue #408) sees this whole-file rewrite as a foreign
      // checkpoint and heals via a generation break — a one-time base re-upload,
      // acceptable now that files are small (cf. vault-plane.ts:~1815-1846).
      const autoVacuum = (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number })
        .auto_vacuum;
      const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number })
        .page_count;
      if (autoVacuum === 0 && pageCount > 0) db.exec('VACUUM');
    }
    return db;
  } catch (err) {
    // WAL mode creates a `-wal`/`-shm` sibling on first write — on a
    // completely full volume even THAT can ENOSPC during open, before any
    // vault command ever runs. Surface it the same as every other write path.
    throw asVaultDiskFullError(`opening ${location}`, err);
  }
}

/** The vault's current `blob_store` settings (`{}`-safe on any shape). */
export function readBlobStoreSettings(vault: DatabaseSync): BlobStoreSettings {
  try {
    const row = vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as
      | { settings_json: string | null }
      | undefined;
    if (!row?.settings_json) return {};
    const parsed = JSON.parse(row.settings_json) as Record<string, unknown>;
    const bag = parsed['blob_store'];
    if (!bag || typeof bag !== 'object') return {};
    const settings = bag as BlobStoreSettings;
    return settings.kind === 's3' ? { ...settings, encrypt: true } : settings;
  } catch {
    return {};
  }
}

/** Open (creating + migrating as needed) the vault pair. */
export function openVaultDb(options: OpenVaultOptions = {}): VaultDb {
  const { dir } = options;
  let vault: DatabaseSync;
  let journal: DatabaseSync;
  let local: LocalBlobStore;
  if (dir === undefined) {
    vault = openFile(':memory:', options.synchronous);
    journal = openFile(':memory:', options.synchronous);
    local = options.blobStore ?? new MemoryBlobStore();
  } else {
    mkdirSync(dir, { recursive: true });
    vault = openFile(path.join(dir, 'vault.db'), options.synchronous);
    journal = openFile(path.join(dir, 'journal.db'), options.synchronous);
    local = options.blobStore ?? new FsBlobStore(path.join(dir, 'blobs'));
  }
  // The FTS sync triggers (and the v2 backfill) decode canonical bodies via
  // this function, so it must exist before migrations touch the file.
  registerContentTextFn(vault);
  // Perceptual-hash distance (issue #299) — near-duplicates are plain SQL.
  registerHammingFn(vault);
  migrate(vault, VAULT_MIGRATIONS);
  migrate(journal, JOURNAL_MIGRATIONS);
  // Issue #406: database-level triggers are the durable write choke point.
  // Install them after each fresh-schema open (including live ext tables
  // restored from a registry); a replica contract-epoch bump invalidates old
  // derived state. Trigger inserts share the mutating statement's transaction.
  initializeReplicaProtocol(vault);
  // A canonical vault commit can survive a process crash before its derived
  // journal S5/audit transaction. Drain those durable proofs before returning
  // handles to any gateway. An unprovable marker fails the open closed and is
  // retained for diagnosis/recovery; no request is served atop an audit gap.
  try {
    repairReplicaInvocationCommits({ vault, journal });
  } catch (error) {
    vault.close();
    journal.close();
    throw error;
  }
  // Key custody resolves AFTER migration so the stamped fingerprint (issue
  // #298 item 1) is readable: a vault that has ever sealed refuses to open
  // with a missing or regenerated key, loudly, instead of minting a fresh
  // DEK that would turn every sealed cell into GCM garbage at reveal time.
  const sealKey =
    options.sealKey ??
    (dir === undefined ? ephemeralSealKey() : resolveSealKey(vault, sealKeyFileFor(dir)));
  const blobContentKeys = new BlobContentKeyRegistry(vault, sealKey);

  // One remote per settings snapshot — rebuilt only when the bag changes.
  // This is also the mechanism behind issue #367 §C9's rotation semantics:
  // changing `endpoint`/`bucket`/`connectionId` changes the JSON key, so the
  // NEXT use resolves a fresh S3BlobStore against the new target. Nothing
  // migrates custody rows explicitly — `reconcile()`/`statusFor()` re-derive
  // custody state from what the (now different) remote actually lists, which
  // is empty for a fresh target, so every live sha reads back "local-only"
  // until replication catches up. The old bucket is never addressed again
  // (no client, no stale credential resolver keeps pointing at it).
  let cachedRemote: { key: string; tier: RemoteTier | null } | null = null;
  const remoteTier = (): RemoteTier | null => {
    const settings = readBlobStoreSettings(vault);
    if (settings.kind !== 's3' || !settings.endpoint || !settings.bucket) return null;
    if (!options.s3Credentials) return null;
    const policy = readBackupPolicy(vault);
    const key = JSON.stringify({
      settings,
      throttle: policy.throttleBytesPerSec,
      class: policy.storageClass,
    });
    if (cachedRemote?.key === key) return cachedRemote.tier;
    const resolver = options.s3Credentials;
    // Every remote CAS object is a CBSF envelope. Ignore stale `false` values
    // so even direct settings writes cannot create plaintext remote objects.
    const throttle = policy.throttleBytesPerSec
      ? { throttleBytesPerSec: policy.throttleBytesPerSec }
      : {};
    // Storage class passthrough (issue #405 §6): unset ⇒ omitted ⇒ the driver
    // sends no x-amz-storage-class header (today's behavior).
    const storageClass = policy.storageClass ? { storageClass: policy.storageClass } : {};
    const s3Options: S3BlobStoreOptions = {
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      prefix: settings.prefix,
      credentials: () => resolver(settings, 'cas'),
      ...throttle,
      ...storageClass,
    };
    const tier: RemoteTier = {
      store: new S3BlobStore(s3Options),
      transfer: new S3TransferStore(s3Options),
      keyFor: (sha256: string) => blobContentKeys.getOrCreate(sha256),
      // Direct-to-cold heuristic (issue #425 Wave 3): resolve the class an
      // eligible large media original's object-creating write carries. Reads
      // policy fresh each call so a `directToColdOriginals` change needs no
      // reopen (the settings snapshot the cache key is built from already
      // carries `supportedStorageClasses`).
      storageClassFor: (sha256, storeClass, originalHint) =>
        storageClassForShaWrite(
          vault,
          sha256,
          storeClass,
          settings.supportedStorageClasses,
          readBackupPolicy(vault),
          originalHint,
        ),
      // The `derived` store (issue #425 Wave 2): a second CAS-shaped store under
      // the target's derived-grant prefix, sharing endpoint/bucket/creds — only
      // the key prefix differs. No transfer store: binary derivatives are small
      // and never take the multipart path. Absent ⇒ derivatives stay on cas.
      ...(settings.derivedPrefix
        ? {
            derivedStore: new S3BlobStore({
              ...s3Options,
              prefix: settings.derivedPrefix,
              credentials: () => resolver(settings, 'derived'),
            }),
          }
        : {}),
    };
    cachedRemote = { key, tier };
    return tier;
  };

  // The bounded storage tier's cache coordinator (issue #405 §3/§4). Only a
  // file-backed vault has a volume to measure, so the derived budget's `statfs`
  // probe is wired ONLY for fs vaults (in-memory vaults get an unlimited budget
  // unless a test sets `blob_cache.budgetBytes` explicitly). The budget's
  // settings read is the CURRENT `blob_cache` row on every check, so changing
  // it needs no reopen — same lazy-settings contract as `remoteTier`.
  const blobsDir = dir === undefined ? undefined : path.join(dir, 'blobs');
  const blobCache = new BlobCache(vault, local, {
    settings: () => readBlobCacheSettings(vault),
    policy: () => readBackupPolicy(vault),
    ...(options.replicationConcurrency !== undefined
      ? { replicationConcurrency: options.replicationConcurrency }
      : {}),
    ...(blobsDir
      ? {
          statfs: () => {
            try {
              const s = statfsSync(blobsDir);
              return { bavail: s.bavail, bsize: s.bsize };
            } catch {
              // The blobs dir may not exist until the first write — treat an
              // unreadable volume as "no measurement" (unlimited) rather than
              // failing a budget check; the disk-full floor (VaultDiskFullError)
              // still guards the real ENOSPC edge.
              return null;
            }
          },
        }
      : {}),
  });
  const blobTransfers = new BlobTransferCoordinator({
    vault,
    dir: dir ?? ':memory:',
    local,
    cache: blobCache,
    remote: remoteTier,
    remoteConfigured: () => readBlobStoreSettings(vault).kind === 's3',
    policy: () => readBackupPolicy(vault),
    contentKeys: blobContentKeys,
    ...(options.shouldDeferBackgroundWork
      ? { shouldDeferBackgroundWork: options.shouldDeferBackgroundWork }
      : {}),
  });

  const api: VaultDb = {
    vault,
    journal,
    dir: dir ?? ':memory:',
    sealKey,
    blobs: new BlobCustody(local, remoteTier, blobCache, (sha) => desiredStoreForSha(vault, sha)),
    // Narrow read-only accessor onto the cached remote-tier closure (issue #439
    // R2) — the lazy-by-default restore's "durable remote CAS tier?" oracle.
    remote: remoteTier,
    blobTransfers,
    // Injected raster codec for the preview backstop (issue #405 §2), or
    // undefined — a codec-less open just never runs the backstop.
    ...(options.previewCodec ? { previewCodec: options.previewCodec } : {}),
    close(opts) {
      // VaultDb's public close contract is synchronous. Fence the runner
      // synchronously so an in-flight provider request cannot settle against
      // SQLite after the handles below close; its durable outbox row resumes
      // on the next open. Callers that need a graceful drain await
      // blobTransfers.close() before closing the DB.
      blobTransfers.abandon();
      // PRAGMA optimize (issue #374 tier 5a): a cheap, targeted ANALYZE that
      // only touches tables whose stats look stale — recommended by SQLite
      // to run "occasionally", and connection-close is the one point every
      // caller reliably passes through, across 188 tables and an ad hoc SQL
      // surface (gateway/sql.ts) the planner would otherwise run stats-blind
      // on. Harmless (near-instant, no-op) on `:memory:` too, so it's left
      // unconditional rather than special-cased. Never let a failure here —
      // this is best-effort maintenance, not correctness — block the actual
      // close of the handle underneath it. A WAL-shipper shutdown passes
      // `skipOptimize` because it already ran optimize before its final
      // checkpoint (see the interface doc).
      if (!opts?.skipOptimize) {
        try {
          vault.exec('PRAGMA optimize');
        } catch {
          // best-effort; the handle still needs to close below.
        }
        try {
          journal.exec('PRAGMA optimize');
        } catch {
          // best-effort; the handle still needs to close below.
        }
      }
      vault.close();
      journal.close();
    },
  };
  return api;
}
