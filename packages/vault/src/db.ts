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

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BlobCustody, type RemoteTier } from './blob/custody.js';
import { FsBlobStore, MemoryBlobStore, type LocalBlobStore } from './blob/local.js';
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
  close(): void;
}

/** The `blob_store` settings bag shape (issue #296 §2). */
export interface BlobStoreSettings {
  kind?: 'fs' | 's3';
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  encrypt?: boolean;
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
  let cachedRemote: { key: string; tier: RemoteTier | null } | null = null;
  const remoteTier = (): RemoteTier | null => {
    const settings = readBlobStoreSettings(vault);
    if (settings.kind !== 's3' || !settings.endpoint || !settings.bucket) return null;
    if (!options.s3Credentials) return null;
    const key = JSON.stringify(settings);
    if (cachedRemote?.key === key) return cachedRemote.tier;
    const resolver = options.s3Credentials;
    const tier: RemoteTier = {
      store: new S3BlobStore({
        endpoint: settings.endpoint,
        bucket: settings.bucket,
        region: settings.region,
        prefix: settings.prefix,
        credentials: () => resolver(settings),
      }),
      encryptKey: settings.encrypt ? sealKey : undefined,
    };
    cachedRemote = { key, tier };
    return tier;
  };

  return {
    vault,
    journal,
    dir: dir ?? ':memory:',
    sealKey,
    blobs: new BlobCustody(local, remoteTier),
    close() {
      vault.close();
      journal.close();
    },
  };
}
