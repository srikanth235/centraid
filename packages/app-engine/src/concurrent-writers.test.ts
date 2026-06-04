/*
 * Concurrent-writer integration: prove the runtime's underlying write
 * path serializes correctly under multi-client contention. Today's
 * Electron embed has effectively one client; once the standalone
 * `centraid-gateway` daemon ships, multiple desktops / phones writing
 * to the same `data.sqlite` is the real case.
 *
 * What we're guarding:
 *   - WAL + busy_timeout pragma must be set on the per-app
 *     `data.sqlite` opener — otherwise concurrent writers race
 *     immediately to SQLITE_BUSY instead of backing off (centraid#131
 *     audit finding).
 *   - Every write must land. Counts and totals must add up.
 *   - The change-bus notifier fires *after* the implicit COMMIT, so
 *     the table set we observe matches the row that actually persisted.
 *
 * Mechanics:
 *   - Spin up a tiny data.sqlite with a `counts` table.
 *   - Fire 50 parallel `writeOp` calls — each inserts one row and
 *     records its onWrite tables in a shared array.
 *   - Assert: 50 rows inserted, 50 onWrite emissions, every emission
 *     mentions `counts`.
 *
 * The test would FAIL deterministically on the old code (no
 * busy_timeout → SQLITE_BUSY exceptions from racing connections).
 */

import { test, beforeEach, afterEach } from 'vitest';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeOp } from './handlers/sql-ops.ts';

let workspace: string;
let dataFile: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), `concurrent-writers-${crypto.randomUUID()}-`),
  );
  dataFile = path.join(workspace, 'data.sqlite');
  // Bootstrap the schema. The opener inside sql-ops runs WAL + busy_timeout
  // for each connection, so we just need the table to exist.
  const db = new DatabaseSync(dataFile);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE counts (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER NOT NULL);
  `);
  db.close();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

test('50 parallel writeOps all land and every onWrite emission mentions the touched table', async () => {
  const N = 50;
  const observedTables: string[][] = [];
  const onWrite = (tables: string[]): void => {
    observedTables.push(tables);
  };
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        writeOp({
          dataFile,
          sql: `INSERT INTO counts (v) VALUES (${i})`,
          onWrite,
        }),
      ),
    ),
  );

  // Every call returned a write result, and rowsAffected was exactly 1.
  assert.equal(results.length, N);
  for (const r of results) assert.equal(r.rowsAffected, 1);

  // The change-bus equivalent (onWrite) fired N times — same count as
  // committed inserts. With emit-after-commit, the 1:1 correspondence
  // is the contract subscribers depend on.
  assert.equal(
    observedTables.length,
    N,
    `expected ${N} onWrite emissions, got ${observedTables.length}`,
  );
  for (const t of observedTables) assert.deepEqual(t, ['counts']);

  // Verify the rows are actually in the DB (not just reported as
  // affected). Independent connection — proves WAL visibility too.
  const verify = new DatabaseSync(dataFile);
  verify.exec('PRAGMA busy_timeout = 30000');
  const row = verify.prepare('SELECT COUNT(*) AS n, SUM(v) AS s FROM counts').get() as {
    n: number;
    s: number;
  };
  verify.close();
  assert.equal(row.n, N);
  // sum 0..N-1 = N*(N-1)/2
  assert.equal(row.s, (N * (N - 1)) / 2);
});

test('a reader concurrent with N writers never throws SQLITE_BUSY', async () => {
  // Spin up writers and a polling reader simultaneously; if busy_timeout
  // is missing, the reader's snapshot acquisition can race a writer's
  // COMMIT and throw immediately. With busy_timeout the reader waits.
  // Yield between reads so the writer promises actually get scheduled.
  const N = 20;
  let readerErr: unknown;
  const readerStop = { done: false };
  const yieldTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const reader = (async () => {
    while (!readerStop.done) {
      try {
        const r = new DatabaseSync(dataFile, { readOnly: true });
        r.exec('PRAGMA busy_timeout = 30000');
        r.prepare('SELECT COUNT(*) FROM counts').get();
        r.close();
      } catch (e) {
        readerErr = e;
        return;
      }
      await yieldTick();
    }
  })();
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        writeOp({ dataFile, sql: `INSERT INTO counts (v) VALUES (${i})` }),
      ),
    ),
  );
  readerStop.done = true;
  await reader;
  assert.equal(readerErr, undefined, `reader observed: ${String(readerErr)}`);
});
