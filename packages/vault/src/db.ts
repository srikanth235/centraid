// One vault owns vault.db and blobs/; only the gateway holds these.
//
// ONE FILE (#916). The sibling `journal.db` is gone: the audit band and the
// conversation-ledger band are bands of vault.db like every other, so a write
// and its receipt share one transaction and a pointer between them is a real
// foreign key. Size is answered by RETENTION (schema/audit.ts,
// `RETENTION_WINDOWS`), not by a second file.

import { existsSync, mkdirSync, statSync, statfsSync } from "node:fs";
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
import { registerCosineFn, registerHammingFn } from "./enrich/similarity.js";
import { asVaultDiskFullError } from "./errors.js";
import { initializeReplicaProtocol } from "./replica/change-log.js";
import { repairReplicaInvocationCommits } from "./replica/invocation-commits.js";
import { registerContentTextFn } from "./schema/fts.js";
import type { KeyStore } from "./schema/key-store.js";
import { migrateVault } from "./schema/migrate.js";
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

/** What one size-based checkpoint pass did, for the caller's log and gauges. */
export interface VaultWalCheckpoint {
  walBytes: number;
  checkpointed: boolean;
  /** A live reader kept some frames; the next pass takes them. */
  busy: boolean;
}

export interface VaultDb {
  vault: DatabaseSync;
  /**
   * The AUDIT BAND's connection — the same handle as `vault`, named for what
   * an audit writer is doing (#916). A writer that means "this is evidence,
   * not model state" says so at the call site; there is no second file to get
   * wrong any more.
   */
  audit: DatabaseSync;
  dir: string;
  /** DEK for sealed columns (#293); outside export/backup/copy. */
  sealKey: Buffer;
  identitySeed: Buffer;
  keyStore?: KeyStore;
  blobs: BlobCustody;
  /** null = full restore required. */
  remote: () => RemoteTier | null;
  blobTransfers: BlobTransferCoordinator;
  previewCodec?: PreviewCodec;
  /**
   * Bound the WAL by SIZE, independently of who else is checkpointing.
   * `wal_autocheckpoint = 0` above hands TRUNCATE to the shipper (#408) and
   * leaves the file to grow for the whole uptime whenever no shipper is
   * attached. PASSIVE, never TRUNCATE: a client holding a read transaction
   * makes TRUNCATE answer `busy` and change nothing at all, while PASSIVE
   * backfills every frame no reader still needs and lets the WAL be REUSED —
   * so the file stops growing, which is the property the disk cares about.
   * A memory vault has no WAL and reports zero.
   */
  checkpointIfLargerThan: (thresholdBytes: number) => VaultWalCheckpoint;
  /** ANALYZE must not sit in the WAL at close (#408). */
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
  encrypt?: boolean;
  connectionId?: string;
  connectionKind?: "provider";
  throttleBytesPerSec?: number;
  storageClass?: string;
  supportedStorageClasses?: string[];
}

export interface OpenVaultOptions {
  dir?: string;
  keyStore?: KeyStore;
  sealKey?: Buffer;
  identitySeed?: Buffer;
  blobStore?: LocalBlobStore;
  /** Never in settings (#296). */
  s3Credentials?: (
    settings: BlobStoreSettings,
    store?: "cas" | "derived"
  ) => Promise<S3Credentials>;
  previewCodec?: PreviewCodec;
  /** Canonical vault only (#721); MUST NOT throw. */
  loadExtensions?: (db: DatabaseSync) => void;
  shouldDeferBackgroundWork?: () => boolean;
  replicationConcurrency?: number;
  /** FULL unless a measured low-end profile chooses NORMAL. */
  synchronous?: "FULL" | "NORMAL";
  footprint?: Partial<VaultFootprintBudget>;
}

function openFile(
  location: string,
  synchronous: "FULL" | "NORMAL" = "FULL",
  footprint?: Partial<VaultFootprintBudget>,
  loadExtensions?: (db: DatabaseSync) => void
): DatabaseSync {
  try {
    // `allowExtension` works only at construction.
    const db = new DatabaseSync(
      location,
      loadExtensions ? { allowExtension: true } : {}
    );
    // Before migrations: they may issue vec queries.
    loadExtensions?.(db);
    db.exec("PRAGMA foreign_keys = ON");
    if (location !== ":memory:") {
      // INCREMENTAL must precede WAL (#438).
      db.exec("PRAGMA page_size = 8192");
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("PRAGMA journal_mode = WAL");
      // NORMAL can drop last commits on power loss.
      db.exec(`PRAGMA synchronous = ${synchronous}`);
      applyVaultFootprint(db, footprint);
      db.exec("PRAGMA temp_store = MEMORY");
      // Workers open the vault by path — wait for locks.
      db.exec("PRAGMA busy_timeout = 30000");
      // WAL-shipper exclusive (#408): foreign checkpoint = whole-DB re-upload.
      db.exec("PRAGMA wal_autocheckpoint = 0");
      // Pre-#438 files read auto_vacuum 0; VACUUM safe only here.
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
  let local: LocalBlobStore;
  if (dir === undefined) {
    vault = openFile(
      ":memory:",
      options.synchronous,
      footprint,
      options.loadExtensions
    );
    local = options.blobStore ?? new MemoryBlobStore();
  } else {
    mkdirSync(dir, { recursive: true });
    vault = openFile(
      path.join(dir, "vault.db"),
      options.synchronous,
      footprint,
      options.loadExtensions
    );
    local = options.blobStore ?? new FsBlobStore(path.join(dir, "blobs"));
  }
  // Must exist before migrations (FTS triggers).
  registerContentTextFn(vault);
  registerHammingFn(vault);
  registerCosineFn(vault);
  migrateVault(vault);
  // Durable write choke (#406), after every fresh-schema open.
  initializeReplicaProtocol(vault);
  // Unprovable marker fails CLOSED.
  try {
    repairReplicaInvocationCommits({ vault, audit: vault });
  } catch (error) {
    vault.close();
    throw error;
  }
  // After migration (#298): sealed vault refuses a regenerated key.
  const sealKey =
    options.sealKey ??
    (dir === undefined
      ? ephemeralSealKey()
      : resolveSealKey(vault, sealKeyFileFor(dir), options.keyStore));
  const identitySeed =
    options.identitySeed ??
    (dir === undefined
      ? ephemeralVaultIdentitySeed()
      : loadOrCreateVaultIdentitySeed(
          identityKeyFileFor(dir),
          options.keyStore
        ));
  const blobContentKeys = new BlobContentKeyRegistry(vault, sealKey);

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
    // Ignore stale `false`: a settings write must not create plaintext.
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
      storageClassFor: (sha256, storeClass, originalHint) =>
        storageClassForShaWrite(
          vault,
          sha256,
          storeClass,
          settings.supportedStorageClasses,
          readBackupPolicy(vault),
          originalHint
        ),
      // Derivatives never take the multipart path (#425).
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
              // Unreadable volume = no measurement, not a failed budget.
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
    audit: vault,
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
    checkpointIfLargerThan(thresholdBytes) {
      if (dir === undefined)
        return { walBytes: 0, checkpointed: false, busy: false };
      const walFile = path.join(dir, "vault.db-wal");
      const walBytes = existsSync(walFile) ? statSync(walFile).size : 0;
      if (walBytes <= thresholdBytes)
        return { walBytes, checkpointed: false, busy: false };
      const row = vault.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as
        | { busy: number; checkpointed: number }
        | undefined;
      return {
        walBytes: existsSync(walFile) ? statSync(walFile).size : 0,
        checkpointed: (row?.checkpointed ?? 0) > 0,
        busy: (row?.busy ?? 0) !== 0,
      };
    },
    close(opts) {
      // Fence the runner: no in-flight request may settle against SQLite.
      blobTransfers.abandon();
      // PRAGMA optimize (#374); never blocks close.
      if (!opts?.skipOptimize) {
        try {
          vault.exec("PRAGMA optimize");
        } catch {
          // best-effort maintenance.
        }
      }
      vault.close();
    },
  };
  return api;
}
