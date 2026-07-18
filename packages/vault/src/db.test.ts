import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { openVaultDb } from './db.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
test('openVaultDb: file-backed vault.db and journal.db open with PRAGMA synchronous = FULL', () => {
  const dir = tempDirSync();
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

test('close() runs PRAGMA optimize on both handles without throwing (issue #374 tier 5a)', () => {
  const db = openVaultDb();
  const vaultExec = vi.spyOn(db.vault, 'exec');
  const journalExec = vi.spyOn(db.journal, 'exec');
  expect(() => db.close()).not.toThrow();
  expect(vaultExec).toHaveBeenCalledWith('PRAGMA optimize');
  expect(journalExec).toHaveBeenCalledWith('PRAGMA optimize');
});

test('close() still closes both handles when PRAGMA optimize itself throws', () => {
  const db = openVaultDb();
  const vaultExec = vi.spyOn(db.vault, 'exec').mockImplementation((sql: string) => {
    if (sql === 'PRAGMA optimize') throw new Error('boom');
  });
  expect(() => db.close()).not.toThrow();
  vaultExec.mockRestore();
  // A closed handle throws on any further statement — proves close() ran.
  expect(() => db.vault.prepare('SELECT 1')).toThrow();
});

test('close() on a file-backed vault also survives PRAGMA optimize without error', () => {
  const dir = tempDirSync('vault-db-optimize-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openVaultDb({ dir });
  expect(() => db.close()).not.toThrow();
});

test('openVaultDb: fresh vault.db and journal.db are auto_vacuum=INCREMENTAL (issue #438)', () => {
  const dir = tempDirSync();
  const db = openVaultDb({ dir });
  cleanups.push(() => db.close());
  // SQLite auto_vacuum enum: NONE=0, FULL=1, INCREMENTAL=2. Both files must be
  // incremental so the #438 archival prune can reclaim freed pages to the OS.
  const vaultAv = db.vault.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number };
  const journalAv = db.journal.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number };
  expect(vaultAv.auto_vacuum).toBe(2);
  expect(journalAv.auto_vacuum).toBe(2);
});

test('openVaultDb: a journal.db created WITHOUT auto_vacuum converts to INCREMENTAL on next open (issue #438)', () => {
  const dir = tempDirSync();
  // Pre-#438 file: WAL, freelist mode (auto_vacuum=0), non-empty.
  const seed = new DatabaseSync(path.join(dir, 'journal.db'));
  seed.exec('PRAGMA journal_mode=WAL');
  seed.exec('CREATE TABLE legacy(a TEXT)');
  const ins = seed.prepare('INSERT INTO legacy VALUES (?)');
  for (let i = 0; i < 500; i++) ins.run('z'.repeat(400));
  seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  expect((seed.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(0);
  seed.close();

  const db = openVaultDb({ dir });
  cleanups.push(() => db.close());
  // The one-time conversion VACUUM in openFile rewrites the file into
  // incremental mode; the file stays in WAL.
  expect(
    (db.journal.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum,
  ).toBe(2);
  expect(
    (db.journal.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
  ).toBe('wal');
});
