// File custody (§10 standing duty): which SQLite files exist, WAL
// checkpointing, backup coordination, and per-app appext_<app_id>.db creation
// and deletion. Custody applies to file-backed vaults; in-memory vaults
// (tests) have no files to keep.
//
// The appext contract (§03, R09): a generated app's extension file may hold
// FKs *into* the vault, the vault never references it, and uninstalling
// deletes the file with zero residue — the revocation cascade calls
// deleteAppExt when an app's last grant dies.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { sha256Hex } from '../ids.js';
import { writeReceipt } from './evidence.js';
import { GatewayError } from './types.js';

function requireDir(db: VaultDb, action: string): string {
  if (db.dir === ':memory:') {
    throw new GatewayError('execution', `${action} needs a file-backed vault`);
  }
  return db.dir;
}

/** Truncate both WAL files back into their databases. */
export function checkpointVault(db: VaultDb): { vault: string; journal: string } {
  requireDir(db, 'checkpoint');
  db.vault.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.journal.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { vault: 'truncated', journal: 'truncated' };
}

export interface BackupResult {
  vaultPath: string;
  journalPath: string;
  vaultSha256: string;
  journalSha256: string;
  receiptId: string;
}

/**
 * Consistent copies of both files via VACUUM INTO, hashed so the owner can
 * verify the copy independently. Export = copy two files and verify hashes
 * (§03) — this is the "copy" half; portability.ts is the semantic half.
 */
export function backupVault(db: VaultDb, destDir: string): BackupResult {
  requireDir(db, 'backup');
  const vaultPath = path.join(destDir, 'vault.backup.db');
  const journalPath = path.join(destDir, 'journal.backup.db');
  for (const p of [vaultPath, journalPath]) rmSync(p, { force: true });
  db.vault.exec(`VACUUM INTO '${vaultPath.replaceAll("'", "''")}'`);
  db.journal.exec(`VACUUM INTO '${journalPath.replaceAll("'", "''")}'`);
  const vaultSha256 = sha256Hex(readFileSync(vaultPath).toString('binary'));
  const journalSha256 = sha256Hex(readFileSync(journalPath).toString('binary'));
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act consent.backup_vault',
    objectType: 'core.vault',
    objectId: null,
    purpose: null,
    decision: 'allow',
    detail: { vaultSha256, journalSha256, destDir },
  });
  return { vaultPath, journalPath, vaultSha256, journalSha256, receiptId };
}

export function appExtPath(db: VaultDb, appId: string): string {
  return path.join(requireDir(db, 'appext'), `appext_${appId}.db`);
}

/**
 * Create (or return) the app's extension file. Its tables may reference the
 * vault; the vault never references them.
 */
export function createAppExt(db: VaultDb, appId: string): string {
  const filePath = appExtPath(db, appId);
  if (!existsSync(filePath)) {
    const ext = new DatabaseSync(filePath);
    ext.exec('PRAGMA journal_mode = WAL');
    ext.close();
  }
  return filePath;
}

/** Uninstall residue removal: the file and its WAL/SHM simply cease to exist. */
export function deleteAppExt(db: VaultDb, appId: string): boolean {
  if (db.dir === ':memory:') return false;
  const filePath = appExtPath(db, appId);
  const existed = existsSync(filePath);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${filePath}${suffix}`, { force: true });
  return existed;
}
