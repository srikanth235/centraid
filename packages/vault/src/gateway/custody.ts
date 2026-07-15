// File custody (§10 standing duty): which SQLite files exist, WAL
// checkpointing, and backup coordination. Custody applies to file-backed
// vaults; in-memory vaults (tests) have no files to keep.
//
// The old attached appext_<app_id>.db files are gone (issue #286 phase 2):
// app extension tables now live INSIDE vault.db as the ext band
// (schema/ext.ts + gateway/ext.ts), so export, FTS, links and consent see
// them like any canonical table. R09 survives band-shaped: ext tables may
// reference the vault, the vault never references them.
//
// `stageVaultDbs` (VACUUM INTO staging for the offsite backup engine) is
// gone (issue #408): the backup path ships WAL segments continuously
// (wal-shipper.ts) instead of rewriting the whole database per snapshot —
// the SSD-wear cliff a 5-minute VACUUM cadence implied (~288 GB/day for a
// 1 GB vault) is the reason it left. `backupVault` stays: it is the
// user-facing export ramp ("copy two files and a directory"), not the
// backup path.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { VaultDb } from '../db.js';
import { writeReceipt } from './evidence.js';
import { GatewayError } from './types.js';

function requireDir(db: VaultDb, action: string): string {
  if (db.dir === ':memory:') {
    throw new GatewayError('execution', `${action} needs a file-backed vault`);
  }
  return db.dir;
}

/**
 * Truncate both WAL files back into their databases.
 *
 * With a WAL shipper attached (issue #408) this MUST NOT be called
 * directly — the shipper is the sole checkpointer (invariant I2) and a
 * checkpoint behind its back destroys unshipped WAL bytes' append-only
 * addressing (detected as a generation break, at the cost of a full base
 * snapshot). Hosts route through `WalShipper.checkpointNow()`, which ships
 * the remainder first; this function remains for shipper-less contexts
 * (tests, one-shot CLI vault surgery).
 */
export function checkpointVault(db: VaultDb): { vault: string; journal: string } {
  requireDir(db, 'checkpoint');
  db.vault.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.journal.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { vault: 'truncated', journal: 'truncated' };
}

/**
 * SHA-256 of a file's raw bytes, streamed (never the whole file in RAM).
 * This matches `shasum -a 256` — the point of recording it is that the
 * owner can verify the copy with standard tools. (The old
 * `readFileSync(p).toString('binary')` implementation UTF-8-re-encoded the
 * latin1 string inside the hash, producing a digest NO external tool could
 * reproduce — and pulled multi-GB files into memory to do it.)
 */
export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export interface BackupResult {
  vaultPath: string;
  journalPath: string;
  vaultSha256: string;
  journalSha256: string;
  /** CAS blobs copied into `<destDir>/blobs` (issue #296). */
  blobsCopied: number;
  receiptId: string;
}

/**
 * Consistent copies of both files via VACUUM INTO, hashed so the owner can
 * verify the copy independently, plus the blob CAS (issue #296: export =
 * copy two files and a directory — the self-contained exit ramp, whatever
 * remote tier settings name). Portability.ts stays the semantic half.
 */
export function backupVault(db: VaultDb, destDir: string): BackupResult {
  requireDir(db, 'backup');
  const vaultPath = path.join(destDir, 'vault.backup.db');
  const journalPath = path.join(destDir, 'journal.backup.db');
  for (const p of [vaultPath, journalPath]) rmSync(p, { force: true });
  db.vault.exec(`VACUUM INTO '${vaultPath.replaceAll("'", "''")}'`);
  db.journal.exec(`VACUUM INTO '${journalPath.replaceAll("'", "''")}'`);
  const vaultSha256 = sha256File(vaultPath);
  const journalSha256 = sha256File(journalPath);
  // Blobs are content-addressed: every copy is verifiable by its filename.
  const { copied } = db.blobs.exportTo(destDir);
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act consent.backup_vault',
    objectType: 'core.vault',
    objectId: null,
    purpose: null,
    decision: 'allow',
    detail: { vaultSha256, journalSha256, destDir, blobsCopied: copied },
  });
  return { vaultPath, journalPath, vaultSha256, journalSha256, blobsCopied: copied, receiptId };
}
