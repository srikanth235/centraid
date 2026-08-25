// One vault owns vault.db, journal.db, blobs/. Only the gateway holds these handles.

import { mkdirSync, statfsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readBackupPolicy } from "./backup-policy.js";
import { BlobCache, readBlobCacheSettings } from "./blob/cache.js";
import { BlobContentKeyRegistry } from "./blob/content-keys.js";
import { BlobCustody } from "./blob/custody.js";
import type { RemoteTier } from "./blob/custody.js";
import { FsBlobStore, MemoryBlobStore } from "./blob/local.js";
import type { LocalBlobStore } from "./blob/local.js";
import { contributeIngressPreviews } from "./blob/preview.js";
import type { IngressPreviewInput, PreviewCodec } from "./blob/preview.js";
import { S3TransferStore } from "./blob/s3-transfer.js";
import { S3BlobStore } from "./blob/s3.js";
import type { S3BlobStoreOptions, S3Credentials } from "./blob/s3.js";
import {
  desiredStoreForSha,
  storageClassForShaWrite,
} from "./blob/store-routing.js";
import { BlobTransferCoordinator } from "./blob/transfers.js";
import { registerHammingFn } from "./enrich/similarity.js";
import { asVaultDiskFullError } from "./errors.js";
import { initializeReplicaProtocol } from "./replica/change-log.js";
import { repairReplicaInvocationCommits } from "./replica/invocation-commits.js";
import { registerContentTextFn } from "./schema/fts.js";
import type { KeyStore } from "./schema/key-store.js";
import { JOURNAL_MIGRATIONS, migrate, migrateVault } from "./schema/migrate.js";
import {
  ephemeralSealKey,
  resolveSealKey,
  sealKeyFileFor,
} from "./schema/sealed.js";
import {
  ephemeralVaultIdentitySeed,
  identityKeyFileFor,
  loadOrCreateVaultIdentitySeed,
} from "./schema/vault-identity.js";
import {
  applyVaultFootprint,
  assertVaultFootprint,
} from "./vault-footprint.js";
import type { VaultFootprintBudget } from "./vault-footprint.js";

export interface VaultDb {
  vault: DatabaseSync;
  journal: DatabaseSync;
  dir: string;
  /** DEK for sealed columns (#293), in `keys/` — outside export/backup/copy, so a copy is ciphertext only. */
  sealKey: Buffer;
  /** Ed25519 signing seed (#726), same custody as `sealKey`. */
  identitySeed: Buffer;
  keyStore?: KeyStore;
  /** Remote resolves lazily from `settings_json.blob_store` each use — switching backends needs no reopen (#296). */
  blobs: BlobCustody;
  /** Current remote CAS tier, or null when full restore is required. */
  remote: () => RemoteTier | null;
  blobTransfers: BlobTransferCoordinator;
  /** Host-injected (#405); absent means `backfillPreviews` never runs. */
  previewCodec?: PreviewCodec;
  /** `skipOptimize` is the WAL-shipper's (#408): ANALYZE must not sit in the WAL at close. */
  close: (opts?: { skipOptimize?: boolean }) => void;
}

export interface BlobStoreSettings {
  kind?: "fs" | "s3";
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  /** MUST stay disjoint from `prefix` and the backup prefix (#425). */
  derivedPrefix?: string;
  /** Legacy. Remote CAS encryption is mandatory in v0. */
  encrypt?: boolean;
  /** Absent = harness-ambient env-var lane in `VaultPlaneOptions` (#367). */
  connectionId?: string;
  connectionKind?: "provider";
  /** Replication upload cap, bytes/sec (#367 §C7). Omitted/0 = unthrottled. */
  throttleBytesPerSec?: number;
  /** `x-amz-storage-class` (#405). Field name IS the wire key (bag is 1:1 JSON). Free-form. */
  storageClass?: string;
  /** Attach-time (#425). Direct-to-cold only if this includes `STANDARD_IA`; BYO-S3 never fires. */
  supportedStorageClasses?: string[];
}

export interface OpenVaultOptions {
  dir?: string;
  /** Same store as endpoint/backup/connection secrets, or OS-protected data dir falls back to the file scheme. */
  keyStore?: KeyStore;
  sealKey?: Buffer;
  identitySeed?: Buffer;
  blobStore?: LocalBlobStore;
  /** Credentials never live in settings (#296). No resolver → s3 vault stays local-only; sweep reports the gap. `store` (#425) mints a store-scoped grant. */
  s3Credentials?: (
    settings: BlobStoreSettings,
    store?: "cas" | "derived"
  ) => Promise<S3Credentials>;
  /** Raster codec for the preview backstop (#405); omitted = no backstop. */
  previewCodec?: PreviewCodec;
  /**
   * Canonical vault handle only, never `journal.db` (#721). Once per handle after open.
   * MUST NOT throw if the extension is unavailable — JS cosine scan (`enrich/similarity.ts`) still searches.
   */
  loadExtensions?: (db: DatabaseSync) => void;
  shouldDeferBackgroundWork?: () => boolean;
  replicationConcurrency?: number;
  /** FULL by default; only a measured low-end profile may choose NORMAL. */
  synchronous?: "FULL" | "NORMAL";
  /** Per-vault memory TOTAL, not a per-file constant. */
  footprint?: Partial<VaultFootprintBudget>;
}

function openFile(
  location: string,
  synchronous: "FULL" | "NORMAL" = "FULL",
  footprint?: Partial<VaultFootprintBudget>,
  loadExtensions?: (db: DatabaseSync) => void
): DatabaseSync {
  try {
    // `allowExtension` at construction (node:sqlite refuses `enableLoadExtension` later).
    const db = new DatabaseSync(
      location,
      loadExtensions ? { allowExtension: true } : {}
    );
    // Before pragma/migration: migrations may issue vec queries.
    loadExtensions?.(db);
    db.exec("PRAGMA foreign_keys = ON");
    if (location !== ":memory:") {
      // INCREMENTAL before WAL (#438): once WAL writes page 1 only a full VACUUM converts.
      db.exec("PRAGMA page_size = 8192");
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("PRAGMA journal_mode = WAL");
      // Durability over throughput: FULL fsyncs WAL each commit; NORMAL can drop last commits on power loss.
      db.exec(`PRAGMA synchronous = ${synchronous}`);
      applyVaultFootprint(db, footprint);
      db.exec("PRAGMA temp_store = MEMORY");
      // Workers open journal.db by path — wait for locks instead of failing immediately.
      db.exec("PRAGMA busy_timeout = 30000");
      // WAL-shipper exclusive (#408): foreign checkpoint costs a whole-DB re-upload. OFF in every by-path opener.
      db.exec("PRAGMA wal_autocheckpoint = 0");
      // Pre-#438 conversion: fresh file reads 2; only a pre-existing non-empty file reads 0. Safe only here (no txn, no other connection).
      const autoVacuum = (
        db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
      ).auto_vacuum;
      const pageCount = (
        db.prepare("PRAGMA page_count").get() as { page_count: number }
      ).page_count;
      if (autoVacuum === 0 && pageCount > 0) db.exec("VACUUM");
    }
    return db;
  } catch (error) {
    throw asVaultDiskFullError(`opening ${location}`, error);
  }
}

export function readBlobStoreSettings(vault: DatabaseSync): BlobStoreSettings {
  try {
    const row = vault
      .prepare("SELECT settings_json FROM core_vault LIMIT 1")
      .get() as { settings_json: string | null } | undefined;
    if (!row?.settings_json) return {};
    const parsed = JSON.parse(row.settings_json) as Record<string, unknown>;
    const bag = parsed["blob_store"];
    if (!bag || typeof bag !== "object") return {};
    const settings = bag as BlobStoreSettings;
    return settings.kind === "s3" ? { ...settings, encrypt: true } : settings;
  } catch {
    return {};
  }
}

export function openVaultDb(options: OpenVaultOptions = {}): VaultDb {
  const { dir } = options;
  assertVaultFootprint(options.footprint);
  const footprint = options.footprint;
  let vault: DatabaseSync;
  let journal: DatabaseSync;
  let local: LocalBlobStore;
  if (dir === undefined) {
    vault = openFile(
      ":memory:",
      options.synchronous,
      footprint,
      options.loadExtensions
    );
    // Journal stays FULL even if the canonical vault is relaxed to NORMAL.
    journal = openFile(":memory:", "FULL", footprint);
    local = options.blobStore ?? new MemoryBlobStore();
  } else {
    mkdirSync(dir, { recursive: true });
    vault = openFile(
      path.join(dir, "vault.db"),
      options.synchronous,
      footprint,
      options.loadExtensions
    );
    journal = openFile(path.join(dir, "journal.db"), "FULL", footprint);
    local = options.blobStore ?? new FsBlobStore(path.join(dir, "blobs"));
  }
  // FTS triggers decode through this — must exist before migrations.
  registerContentTextFn(vault);
  registerHammingFn(vault);
  migrateVault(vault);
  migrate(journal, JOURNAL_MIGRATIONS);
  // Durable write choke (#406): after every fresh-schema open, including ext tables restored from a registry.
  initializeReplicaProtocol(vault);
  // A vault commit can outlive a lost journal S5/audit txn. Unprovable marker fails open CLOSED.
  try {
    repairReplicaInvocationCommits({ vault, journal });
  } catch (error) {
    vault.close();
    journal.close();
    throw error;
  }
  // After migration so the stamped fingerprint (#298) is readable: a sealed vault must refuse a missing/regenerated key.
  const sealKey =
    options.sealKey ??
    (dir === undefined
      ? ephemeralSealKey()
      : resolveSealKey(vault, sealKeyFileFor(dir), options.keyStore));
  // Signing identity (#726): same custody as the DEK, no fingerprint gate.
  const identitySeed =
    options.identitySeed ??
    (dir === undefined
      ? ephemeralVaultIdentitySeed()
      : loadOrCreateVaultIdentitySeed(
          identityKeyFileFor(dir),
          options.keyStore
        ));
  const blobContentKeys = new BlobContentKeyRegistry(vault, sealKey);

  // One remote per settings snapshot (#367 §C9): changed endpoint/bucket/connectionId changes the key; custody rows are re-derived.
  let cachedRemote: { key: string; tier: RemoteTier | null } | null = null;
  const remoteTier = (): RemoteTier | null => {
    const settings = readBlobStoreSettings(vault);
    if (settings.kind !== "s3" || !settings.endpoint || !settings.bucket)
      return null;
    if (!options.s3Credentials) return null;
    const policy = readBackupPolicy(vault);
    const key = JSON.stringify({
      settings,
      throttle: policy.throttleBytesPerSec,
      class: policy.storageClass,
    });
    if (cachedRemote?.key === key) return cachedRemote.tier;
    const resolver = options.s3Credentials;
    // Every remote CAS object is a CBSF envelope: ignore stale `false` so a settings write cannot create plaintext.
    const throttle = policy.throttleBytesPerSec
      ? { throttleBytesPerSec: policy.throttleBytesPerSec }
      : {};
    const storageClass = policy.storageClass
      ? { storageClass: policy.storageClass }
      : {};
    const s3Options: S3BlobStoreOptions = {
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      prefix: settings.prefix,
      credentials: () => resolver(settings, "cas"),
      ...throttle,
      ...storageClass,
    };
    const tier: RemoteTier = {
      store: new S3BlobStore(s3Options),
      transfer: new S3TransferStore(s3Options),
      keyFor: (sha256: string) => blobContentKeys.getOrCreate(sha256),
      // Direct-to-cold (#425): policy fresh each call so a `directToColdOriginals` change needs no reopen.
      storageClassFor: (sha256, storeClass, originalHint) =>
        storageClassForShaWrite(
          vault,
          sha256,
          storeClass,
          settings.supportedStorageClasses,
          readBackupPolicy(vault),
          originalHint
        ),
      // Derived-grant prefix (#425). No transfer store: derivatives never take the multipart path.
      ...(settings.derivedPrefix
        ? {
            derivedStore: new S3BlobStore({
              ...s3Options,
              prefix: settings.derivedPrefix,
              credentials: () => resolver(settings, "derived"),
            }),
          }
        : {}),
    };
    cachedRemote = { key, tier };
    return tier;
  };

  // `statfs` for fs vaults only (#405); in-memory = unlimited. Settings re-read each check (same lazy contract as `remoteTier`).
  const blobsDir = dir === undefined ? undefined : path.join(dir, "blobs");
  const blobCache = new BlobCache(vault, local, {
    settings: () => readBlobCacheSettings(vault),
    policy: () => readBackupPolicy(vault),
    ...(options.replicationConcurrency === undefined
      ? {}
      : { replicationConcurrency: options.replicationConcurrency }),
    ...(blobsDir
      ? {
          statfs: () => {
            try {
              const s = statfsSync(blobsDir);
              return { bavail: s.bavail, bsize: s.bsize };
            } catch {
              // Unreadable volume = no measurement, not a failed budget. VaultDiskFullError still guards ENOSPC.
              return null;
            }
          },
        }
      : {}),
  });
  const blobTransfers = new BlobTransferCoordinator({
    vault,
    dir: dir ?? ":memory:",
    local,
    cache: blobCache,
    remote: remoteTier,
    remoteConfigured: () => readBlobStoreSettings(vault).kind === "s3",
    policy: () => readBackupPolicy(vault),
    contentKeys: blobContentKeys,
    // Capture-time previews (#405). Fire-and-forget; closes over `api` so it only fires post-open.
    ...(options.previewCodec && {
      contributePreview: (input: IngressPreviewInput) =>
        void contributeIngressPreviews(api, options.previewCodec!, input).catch(
          () => {}
        ),
    }),
    ...(options.shouldDeferBackgroundWork
      ? { shouldDeferBackgroundWork: options.shouldDeferBackgroundWork }
      : {}),
  });

  const api: VaultDb = {
    vault,
    journal,
    dir: dir ?? ":memory:",
    sealKey,
    identitySeed,
    ...(options.keyStore ? { keyStore: options.keyStore } : {}),
    blobs: new BlobCustody(local, remoteTier, blobCache, (sha) =>
      desiredStoreForSha(vault, sha)
    ),
    remote: remoteTier,
    blobTransfers,
    ...(options.previewCodec ? { previewCodec: options.previewCodec } : {}),
    close(opts) {
      // Close is sync: fence the runner so no in-flight provider request settles against SQLite. Drain via blobTransfers.close() first.
      blobTransfers.abandon();
      // `PRAGMA optimize` (#374) here — the one point every caller passes. Failure must never block close.
      if (!opts?.skipOptimize) {
        try {
          vault.exec("PRAGMA optimize");
        } catch {
          // best-effort maintenance.
        }
        try {
          journal.exec("PRAGMA optimize");
        } catch {
          // best-effort maintenance.
        }
      }
      vault.close();
      journal.close();
    },
  };
  return api;
}
