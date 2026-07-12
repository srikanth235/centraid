import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
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
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-db-optimize-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openVaultDb({ dir });
  expect(() => db.close()).not.toThrow();
});
