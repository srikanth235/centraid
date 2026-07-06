// The two-file physical layout from §03: vault.db holds all eleven schemas
// (model rows, engine-enforced FKs, one ACID boundary); journal.db holds the
// append-only audit stream (receipts, provenance, invocations, checks,
// evidence, explanations). Export = copy two files and verify hashes.
//
// Only the gateway holds these handles — apps, agents and generated views
// never see a connection (§10). Everything outside this package should go
// through createGateway().

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerContentTextFn } from './schema/fts.js';
import { JOURNAL_MIGRATIONS, migrate, VAULT_MIGRATIONS } from './schema/migrate.js';
import { ephemeralSealKey, loadOrCreateSealKey, sealKeyFileFor } from './schema/sealed.js';

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
  close(): void;
}

export interface OpenVaultOptions {
  /** Directory for vault.db + journal.db. Omit for in-memory (tests). */
  dir?: string;
  /** Override the seal key (custody managed by the caller). */
  sealKey?: Buffer;
}

function openFile(location: string): DatabaseSync {
  const db = new DatabaseSync(location);
  db.exec('PRAGMA foreign_keys = ON');
  if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/** Open (creating + migrating as needed) the vault pair. */
export function openVaultDb(options: OpenVaultOptions = {}): VaultDb {
  const { dir } = options;
  let vault: DatabaseSync;
  let journal: DatabaseSync;
  let sealKey: Buffer;
  if (dir === undefined) {
    vault = openFile(':memory:');
    journal = openFile(':memory:');
    sealKey = options.sealKey ?? ephemeralSealKey();
  } else {
    mkdirSync(dir, { recursive: true });
    vault = openFile(path.join(dir, 'vault.db'));
    journal = openFile(path.join(dir, 'journal.db'));
    sealKey = options.sealKey ?? loadOrCreateSealKey(sealKeyFileFor(dir));
  }
  // The FTS sync triggers (and the v2 backfill) decode canonical bodies via
  // this function, so it must exist before migrations touch the file.
  registerContentTextFn(vault);
  migrate(vault, VAULT_MIGRATIONS);
  migrate(journal, JOURNAL_MIGRATIONS);
  return {
    vault,
    journal,
    dir: dir ?? ':memory:',
    sealKey,
    close() {
      vault.close();
      journal.close();
    },
  };
}
