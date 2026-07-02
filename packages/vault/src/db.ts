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
import { JOURNAL_MIGRATIONS, migrate, VAULT_MIGRATIONS } from './schema/migrate.js';

export interface VaultDb {
  vault: DatabaseSync;
  journal: DatabaseSync;
  /** Directory holding vault.db + journal.db, or ':memory:'. */
  dir: string;
  close(): void;
}

export interface OpenVaultOptions {
  /** Directory for vault.db + journal.db. Omit for in-memory (tests). */
  dir?: string;
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
  if (dir === undefined) {
    vault = openFile(':memory:');
    journal = openFile(':memory:');
  } else {
    mkdirSync(dir, { recursive: true });
    vault = openFile(path.join(dir, 'vault.db'));
    journal = openFile(path.join(dir, 'journal.db'));
  }
  migrate(vault, VAULT_MIGRATIONS);
  migrate(journal, JOURNAL_MIGRATIONS);
  return {
    vault,
    journal,
    dir: dir ?? ':memory:',
    close() {
      vault.close();
      journal.close();
    },
  };
}
