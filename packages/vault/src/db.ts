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
import { FsBlobStore, MemoryBlobStore, type LocalBlobStore } from './blob/local.js';
import type { PreviewCodec } from './blob/preview.js';
import { S3BlobStore, type S3Credentials } from './blob/s3.js';
import { registerHammingFn } from './enrich/similarity.js';
import { asVaultDiskFullError } from './errors.js';
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
   * Encrypt remote objects under the vault DEK (issue #367). Defaults to
   * `true` — a remote tier is off-vault-disk by definition, so encryption
   * is opt-OUT, not opt-in. Only meaningful when `connectionKind` is NOT
   * `'provider'`: a provider-backed connection cannot disable this (see
   * `connectionKind` below and `openVaultDb`'s `remoteTier()`).
   */
  encrypt?: boolean;
  /**
   * The gateway-level `storage-connections` entity (#367 §C1) this vault's
   * remote tier resolves credentials from. When set, `s3Credentials` is
   * expected to resolve creds keyed off this id (byo-s3: the sealed
   * sidecar; provider: a short-lived `requestCasGrant`). Absent = the
   * legacy harness-ambient env-var lane (`VaultPlaneOptions`'s default
   * `s3Credentials`).
   */
  connectionId?: string;
  /**
   * Denormalized copy of the connection's kind, stamped by the gateway
   * whenever it wires `connectionId` (issue #367 §C4) — read here so the
   * vault package can enforce "encryption is force-ON for provider
   * connections" without a live round-trip back to the gateway's
   * storage-connection store. Never trust an ABSENT value to mean
   * `'byo-s3'` is safe to assume off-path; it only relaxes the default.
   */
  connectionKind?: 'byo-s3' | 'provider';
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
   * replication sweep reports the gap instead of failing writes.
   */
  s3Credentials?: (settings: BlobStoreSettings) => Promise<S3Credentials>;
  /**
   * The preview ladder's raster codec (issue #405 §2) — the gateway host
   * passes its jpeg-js/pngjs implementation so the blob sweep's backstop can
   * generate missing thumb/preview derivatives. Omitted for hosts (and tests)
   * with no codec: the backstop simply doesn't run.
   */
  previewCodec?: PreviewCodec;
}

function openFile(location: string): DatabaseSync {
  try {
    const db = new DatabaseSync(location);
    db.exec('PRAGMA foreign_keys = ON');
    if (location !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
      // This is a personal-data vault with a low write rate — durability of
      // each commit matters more than write throughput, so fsync on every
      // transaction (WAL's default NORMAL can drop the last commit(s) on
      // power loss; FULL fsyncs the WAL on every commit).
      db.exec('PRAGMA synchronous = FULL');
      // journal.db also carries the conversation-ledger band (the old
      // transcripts.db folded in), which worker subprocesses open by path —
      // wait for their locks instead of failing immediately.
      db.exec('PRAGMA busy_timeout = 30000');
      // Checkpointing is the WAL shipper's exclusive duty (issue #408, I2):
      // segments are raw WAL byte ranges, and they are only valid while the
      // WAL is strictly append-only between checkpoints THE SHIPPER performs
      // (TRUNCATE-only — PASSIVE/RESTART reuse byte offsets in place). An
      // autocheckpointing connection would reset the WAL behind the
      // shipper's back; it detects that (salt/size/main-file detectors) and
      // heals with a full base snapshot, but every such heal is a whole-DB
      // upload — so autocheckpoint is OFF on every connection, here and in
      // every by-path opener (app-engine's openJournalDb, key-admin).
      db.exec('PRAGMA wal_autocheckpoint = 0');
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
    return bag && typeof bag === 'object' ? (bag as BlobStoreSettings) : {};
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
    vault = openFile(':memory:');
    journal = openFile(':memory:');
    local = options.blobStore ?? new MemoryBlobStore();
  } else {
    mkdirSync(dir, { recursive: true });
    vault = openFile(path.join(dir, 'vault.db'));
    journal = openFile(path.join(dir, 'journal.db'));
    local = options.blobStore ?? new FsBlobStore(path.join(dir, 'blobs'));
  }
  // The FTS sync triggers (and the v2 backfill) decode canonical bodies via
  // this function, so it must exist before migrations touch the file.
  registerContentTextFn(vault);
  // Perceptual-hash distance (issue #299) — near-duplicates are plain SQL.
  registerHammingFn(vault);
  migrate(vault, VAULT_MIGRATIONS);
  migrate(journal, JOURNAL_MIGRATIONS);
  // Key custody resolves AFTER migration so the stamped fingerprint (issue
  // #298 item 1) is readable: a vault that has ever sealed refuses to open
  // with a missing or regenerated key, loudly, instead of minting a fresh
  // DEK that would turn every sealed cell into GCM garbage at reveal time.
  const sealKey =
    options.sealKey ??
    (dir === undefined ? ephemeralSealKey() : resolveSealKey(vault, sealKeyFileFor(dir)));

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
    const key = JSON.stringify(settings);
    if (cachedRemote?.key === key) return cachedRemote.tier;
    const resolver = options.s3Credentials;
    // Encryption default-ON (issue #367 §C4): opt-OUT via `encrypt: false`,
    // except a `provider`-kind connection may never opt out — the operator
    // doesn't control that bucket's access boundary the way they do a BYO
    // one, so the vault's own AEAD envelope is the only guarantee.
    const forceEncrypt = settings.connectionKind === 'provider';
    const encryptOn = forceEncrypt || settings.encrypt !== false;
    const tier: RemoteTier = {
      store: new S3BlobStore({
        endpoint: settings.endpoint,
        bucket: settings.bucket,
        region: settings.region,
        prefix: settings.prefix,
        credentials: () => resolver(settings),
        ...(settings.throttleBytesPerSec
          ? { throttleBytesPerSec: settings.throttleBytesPerSec }
          : {}),
        // Storage class passthrough (issue #405 §6): unset ⇒ omitted ⇒ the
        // driver sends no x-amz-storage-class header (today's behavior).
        ...(settings.storageClass ? { storageClass: settings.storageClass } : {}),
      }),
      encryptKey: encryptOn ? sealKey : undefined,
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

  return {
    vault,
    journal,
    dir: dir ?? ':memory:',
    sealKey,
    blobs: new BlobCustody(local, remoteTier, blobCache),
    // Injected raster codec for the preview backstop (issue #405 §2), or
    // undefined — a codec-less open just never runs the backstop.
    ...(options.previewCodec ? { previewCodec: options.previewCodec } : {}),
    close(opts) {
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
}
