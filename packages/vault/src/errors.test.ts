import { tempDirSync } from '@centraid/test-kit/temp-dir';
// Disk-full classification units (issue #351 wave 4). `PRAGMA max_page_count`
// gives a deterministic, REAL SQLITE_FULL condition — no mocking node:sqlite
// — so the classifier is verified against what node:sqlite actually throws,
// and the transaction-atomicity claim (a failed write rolls back cleanly,
// the connection stays usable) is verified against a real failure, not an
// assumption. The genuine full-FILESYSTEM path (real ENOSPC from `write(2)`)
// is covered by the gated e2e in blob/disk-full.e2e.test.ts — this file's
// blob-cleanup test uses an injected `writeSync` failure only because
// reliably filling a real filesystem inside the fast unit suite would need
// the same disk-image dance as that e2e (see its header for why that's
// gated instead of always-on).

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  asVaultDiskFullError,
  DiskFullTracker,
  isDiskFullError,
  sharedDiskFullTracker,
  VaultDiskFullError,
} from './errors.js';
import { FsBlobStore } from './blob/local.js';

// ESM's `node:fs` module namespace isn't configurable, so `vi.spyOn` can't
// stub a single export directly (vitest#limitation) — this mocks the whole
// module through to the real implementation, with `writeSync` swapped for a
// toggleable stub, so the one test below can force an ENOSPC-shaped failure
// deterministically without touching any other call in this file.
let writeSyncShouldFail = false;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (writeSyncShouldFail) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return actual.writeSync(...args);
    },
  };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
}); /** Fill a `:memory:` sqlite db past `PRAGMA max_page_count` — a real SQLITE_FULL. */
function triggerSqliteFull(): { db: DatabaseSync; err: unknown } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA max_page_count = 4;');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT)');
  const stmt = db.prepare('INSERT INTO t (data) VALUES (?)');
  let err: unknown;
  try {
    for (let i = 0; i < 100_000; i++) stmt.run('x'.repeat(2000));
  } catch (e) {
    err = e;
  }
  return { db, err };
}

test('isDiskFullError: recognizes a real node:sqlite SQLITE_FULL', () => {
  const { db, err } = triggerSqliteFull();
  cleanups.push(() => db.close());
  expect(err).toBeDefined();
  // Probe findings (node 22.22.2, node:sqlite): the error is a plain `Error`
  // with `code: 'ERR_SQLITE_ERROR'`, `errcode: 13` (SQLITE_FULL per
  // sqlite3.h), `errstr: 'database or disk is full'`.
  expect((err as { code?: string }).code).toBe('ERR_SQLITE_ERROR');
  expect((err as { errcode?: number }).errcode).toBe(13);
  expect(isDiskFullError(err)).toBe(true);
});

test('isDiskFullError: recognizes ENOSPC from fs errors', () => {
  const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  expect(isDiskFullError(enospc)).toBe(true);
});

test('isDiskFullError: false for an unrelated error', () => {
  expect(isDiskFullError(new Error('constraint failed'))).toBe(false);
  expect(isDiskFullError(new TypeError('bad input'))).toBe(false);
  expect(isDiskFullError(null)).toBe(false);
  expect(isDiskFullError(undefined)).toBe(false);
  expect(isDiskFullError('a string')).toBe(false);
  const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
  expect(isDiskFullError(enoent)).toBe(false);
});

test('a failed SQLITE_FULL transaction rolls back cleanly and leaves the connection usable', () => {
  const { db, err } = triggerSqliteFull();
  cleanups.push(() => db.close());
  expect(isDiskFullError(err)).toBe(true);
  // Raise the cap back and confirm the SAME connection still accepts writes
  // and the row count matches only what committed before the failure (no
  // half-applied insert survived).
  const before = (db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c;
  expect(before).toBeGreaterThan(0);
  db.exec('PRAGMA max_page_count = 100000;');
  db.prepare('INSERT INTO t (data) VALUES (?)').run('after-recovery');
  const after = (db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c;
  expect(after).toBe(before + 1);
});

test('asVaultDiskFullError: reclassifies a disk-full error, passes through everything else', () => {
  const { db, err } = triggerSqliteFull();
  cleanups.push(() => db.close());
  const wrapped = asVaultDiskFullError('unit test write', err);
  expect(wrapped).toBeInstanceOf(VaultDiskFullError);
  expect((wrapped as VaultDiskFullError).context).toBe('unit test write');
  expect(wrapped.message).toContain('unit test write');

  const other = new Error('some other bug');
  expect(asVaultDiskFullError('unit test write', other)).toBe(other);
});

test('asVaultDiskFullError: reports disk-full into sharedDiskFullTracker so the gateway health probe sees it without extra wiring', () => {
  sharedDiskFullTracker.clear();
  const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  asVaultDiskFullError('unit test shared-tracker write', enospc);
  const event = sharedDiskFullTracker.current();
  expect(event?.context).toBe('unit test shared-tracker write');
  sharedDiskFullTracker.clear();

  // Non-disk-full errors must NOT pollute the tracker.
  asVaultDiskFullError('unrelated', new Error('constraint failed'));
  expect(sharedDiskFullTracker.current()).toBeNull();
});

test('DiskFullTracker: reports only disk-full errors, clears on demand', () => {
  const tracker = new DiskFullTracker();
  expect(tracker.current()).toBeNull();
  tracker.report(new Error('unrelated'), 'ctx-a');
  expect(tracker.current()).toBeNull();
  const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  tracker.report(enospc, 'ctx-b');
  const event = tracker.current();
  expect(event?.context).toBe('ctx-b');
  expect(event?.message).toContain('no space left');
  expect(typeof event?.at).toBe('string');
  tracker.clear();
  expect(tracker.current()).toBeNull();
});

test('FsBlobStore.putSync: ENOSPC cleans up the partial tmp file and rethrows VaultDiskFullError', () => {
  const dir = tempDirSync();
  const store = new FsBlobStore(dir);
  const sha = 'b'.repeat(64);
  writeSyncShouldFail = true;
  try {
    expect(() => store.putSync(sha, Buffer.from('hello'))).toThrow(VaultDiskFullError);
  } finally {
    writeSyncShouldFail = false;
  }
  const fanoutDir = path.join(dir, 'sha256', sha.slice(0, 2));
  const leftover = existsSync(fanoutDir) ? readdirSync(fanoutDir) : [];
  expect(leftover).toEqual([]); // no half-written blob or stray .tmp file
});
