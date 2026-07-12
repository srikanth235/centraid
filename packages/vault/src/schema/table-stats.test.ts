import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { dbSizeBreakdown } from './table-stats.js';

test('dbstat is available in this repo\'s node:sqlite build (issue #367 probe)', () => {
  const db = new DatabaseSync(':memory:');
  // Throws if ENABLE_DBSTAT_VTAB is not compiled in — this asserts the
  // probe finding stays true rather than silently bit-rotting.
  expect(() => db.prepare('SELECT * FROM dbstat LIMIT 1').all()).not.toThrow();
});

test('dbSizeBreakdown reports per-table bytes via dbstat, indexes rolled into their table', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE big(a INTEGER PRIMARY KEY, b TEXT)');
  db.exec('CREATE INDEX idx_big_b ON big(b)');
  db.exec('CREATE TABLE tiny(a INTEGER PRIMARY KEY)');
  const stmt = db.prepare('INSERT INTO big(b) VALUES (?)');
  for (let i = 0; i < 300; i++) stmt.run('x'.repeat(200) + i);
  db.exec("INSERT INTO tiny(a) VALUES (1)");

  const breakdown = dbSizeBreakdown(db);

  expect(breakdown.method).toBe('dbstat');
  expect(breakdown.pageCount).toBeGreaterThan(0);
  expect(breakdown.pageSize).toBeGreaterThan(0);
  expect(breakdown.fileBytesTotal).toBe(breakdown.pageCount * breakdown.pageSize);

  const big = breakdown.tables.find((t) => t.table === 'big');
  const tiny = breakdown.tables.find((t) => t.table === 'tiny');
  expect(big).toBeDefined();
  expect(tiny).toBeDefined();
  // `big` (300 wide rows + its own index) must dominate `tiny` (one row).
  expect(big!.bytes!).toBeGreaterThan(tiny!.bytes!);
  // Sorted biggest-first.
  expect(breakdown.tables[0]!.table).toBe('big');
  // The index's bytes are folded into `big`, not listed as its own "table".
  expect(breakdown.tables.some((t) => t.table === 'idx_big_b')).toBe(false);
});

test('falls back to a row-count estimate honestly labeled when dbstat is unavailable', () => {
  const real = new DatabaseSync(':memory:');
  real.exec('CREATE TABLE widgets(id INTEGER PRIMARY KEY, name TEXT)');
  real.exec("INSERT INTO widgets(name) VALUES ('a'), ('b'), ('c')");

  // Duck-typed stub: same `.prepare(sql).all()/.get()` surface, but the
  // dbstat query throws — simulates a build without ENABLE_DBSTAT_VTAB.
  const stub = {
    prepare(sql: string) {
      if (sql.includes('FROM dbstat')) {
        return {
          all: () => {
            throw new Error('no such table: dbstat');
          },
        };
      }
      return real.prepare(sql);
    },
  } as unknown as DatabaseSync;

  const breakdown = dbSizeBreakdown(stub);

  expect(breakdown.method).toBe('estimate');
  expect(breakdown.tables).toEqual([{ table: 'widgets', rows: 3 }]);
  // No byte figures fabricated for the estimate path.
  expect(breakdown.tables[0]!.bytes).toBeUndefined();
});
