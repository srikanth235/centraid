import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openVaultDb } from './db.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-db-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('openVaultDb: file-backed vault.db and journal.db open with PRAGMA synchronous = FULL', () => {
  const dir = tempDir();
  const db = openVaultDb({ dir });
  cleanups.push(() => db.close());
  const vaultSync = db.vault.prepare('PRAGMA synchronous').get() as { synchronous: number };
  const journalSync = db.journal.prepare('PRAGMA synchronous').get() as { synchronous: number };
  // SQLite's synchronous enum: OFF=0, NORMAL=1, FULL=2, EXTRA=3.
  expect(vaultSync.synchronous).toBe(2);
  expect(journalSync.synchronous).toBe(2);
});

test('openVaultDb: in-memory vaults still open fine (pragma is file-backed only)', () => {
  const db = openVaultDb();
  cleanups.push(() => db.close());
  expect(db.dir).toBe(':memory:');
});
