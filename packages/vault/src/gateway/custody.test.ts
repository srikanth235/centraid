// File custody (§10): `stageVaultDbs` is the narrow half of `backupVault`
// the offsite backup engine uses — VACUUM INTO copies of the two SQLite
// files only, named to match the `centraid-snapshot/1` entry paths
// (`vault.db` / `journal.db`, FORMAT.md), receipted the same way.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { backupVault, checkpointVault, stageVaultDbs } from './custody.js';

let root: string;
let vaultDir: string;
let db: VaultDb;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'custody-stage-'));
  vaultDir = path.join(root, 'vault-a');
  db = openVaultDb({ dir: vaultDir });
  bootstrapVault(db, { ownerName: 'Priya' });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('stageVaultDbs writes openable vault.db + journal.db copies, receipted', () => {
  checkpointVault(db); // truncate the WAL so VACUUM INTO sees committed rows
  const destDir = path.join(root, 'staging');
  mkdirSync(destDir, { recursive: true });

  const result = stageVaultDbs(db, destDir);

  expect(result.vaultPath).toBe(path.join(destDir, 'vault.db'));
  expect(result.journalPath).toBe(path.join(destDir, 'journal.db'));
  expect(existsSync(result.vaultPath)).toBe(true);
  expect(existsSync(result.journalPath)).toBe(true);
  expect(result.vaultSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.journalSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.receiptId).toBeTruthy();

  // The copy is a real, independently openable SQLite file carrying the
  // vault's own row — not just bytes that happen to exist.
  const copy = new DatabaseSync(result.vaultPath, { readOnly: true });
  try {
    const row = copy.prepare('SELECT display_name FROM core_vault LIMIT 1').get() as
      | { display_name: string }
      | undefined;
    expect(row?.display_name).toBe("Priya's vault");
  } finally {
    copy.close();
  }

  // The receipt landed in the journal (appended, not overwritten).
  const receiptRow = db.journal
    .prepare('SELECT action FROM consent_receipt WHERE receipt_id = ?')
    .get(result.receiptId) as { action: string } | undefined;
  expect(receiptRow?.action).toBe('act consent.backup_stage_dbs');
});

test('stageVaultDbs does NOT touch the blob CAS (backupVault does)', () => {
  checkpointVault(db);
  db.blobs.ingestSync(Buffer.from('hello offsite backup'));

  const stageDest = path.join(root, 'stage-only');
  mkdirSync(stageDest, { recursive: true });
  stageVaultDbs(db, stageDest);
  expect(existsSync(path.join(stageDest, 'blobs'))).toBe(false);

  const fullDest = path.join(root, 'full-backup');
  mkdirSync(fullDest, { recursive: true });
  const full = backupVault(db, fullDest);
  expect(full.blobsCopied).toBe(1);
  expect(existsSync(path.join(fullDest, 'blobs'))).toBe(true);
});

test('stageVaultDbs refuses an in-memory vault (no files to stage)', () => {
  const mem = openVaultDb();
  try {
    expect(() => stageVaultDbs(mem, root)).toThrow(/file-backed vault/);
  } finally {
    mem.close();
  }
});
