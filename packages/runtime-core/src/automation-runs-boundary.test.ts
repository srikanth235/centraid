/**
 * Boundary test: the per-app `automations.sqlite` audit/state file is
 * NOT reachable from the handler's `db` proxy or the `centraid_sql_*`
 * agent tools (see issue #80 acceptance criterion).
 *
 * Both surfaces take the app's `data.sqlite` path explicitly; the
 * `automations.sqlite` file sits next to it but is never substituted.
 * This test asserts:
 *   1. `describeOp` over `data.sqlite` does NOT list runs/run_nodes/state
 *      even when `automations.sqlite` has been populated.
 *   2. `readOp` over `data.sqlite` errors when asked to SELECT from
 *      runs/run_nodes/state — they don't exist in that file.
 *   3. The `data.sqlite` and `automations.sqlite` files are
 *      independent: writing to one does not leak into the other.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AutomationRunsStore } from './automation-runs-store.js';
import { automationsDbPath } from './automation-runs-schema.js';
import { describeOp, readOp, SqlOpRefusalError } from './sql-ops.js';
import { RunQueryError } from './run-query.js';

function makeApp(): { appDir: string; dataFile: string; runsStore: AutomationRunsStore } {
  const appDir = mkdtempSync(path.join(tmpdir(), 'centraid-boundary-'));
  const dataFile = path.join(appDir, 'data.sqlite');
  // Seed data.sqlite with one app table so describeOp returns a real schema.
  const db = new DatabaseSync(dataFile);
  db.exec('CREATE TABLE issues (id INTEGER PRIMARY KEY, title TEXT)');
  db.exec(`INSERT INTO issues VALUES (1, 'first')`);
  db.close();
  const runsStore = new AutomationRunsStore(automationsDbPath(appDir));
  // Seed automations.sqlite so we'd have a leak if the boundary was broken.
  runsStore.insertRun({
    runId: 'r1',
    automationName: 'leaked?',
    triggerKind: 'scheduled',
    startedAt: 1,
  });
  runsStore.finishRun({ runId: 'r1', endedAt: 2, ok: true });
  runsStore.stateSet('leaked?', 'k', JSON.stringify({ secret: 'value' }), 1);
  return { appDir, dataFile, runsStore };
}

describe('centraid_sql_* boundary against automations.sqlite (issue #80)', () => {
  it('describeOp on data.sqlite hides runs / run_nodes / state', () => {
    const { dataFile, runsStore } = makeApp();
    try {
      const result = describeOp({ dataFile });
      const tableNames = result.tables.map((t) => t.name);
      assert.ok(!tableNames.includes('runs'));
      assert.ok(!tableNames.includes('run_nodes'));
      assert.ok(!tableNames.includes('state'));
      assert.ok(tableNames.includes('issues'), 'data.sqlite tables should still be visible');
    } finally {
      runsStore.close();
    }
  });

  it('readOp on data.sqlite cannot SELECT from runs (table does not exist there)', () => {
    const { dataFile, runsStore } = makeApp();
    try {
      assert.throws(
        () => readOp({ dataFile, sql: 'SELECT * FROM runs' }),
        (err) => err instanceof RunQueryError || err instanceof SqlOpRefusalError,
      );
    } finally {
      runsStore.close();
    }
  });

  it('readOp on data.sqlite cannot SELECT from run_nodes or state', () => {
    const { dataFile, runsStore } = makeApp();
    try {
      assert.throws(
        () => readOp({ dataFile, sql: 'SELECT * FROM run_nodes' }),
        (err) => err instanceof RunQueryError || err instanceof SqlOpRefusalError,
      );
      assert.throws(
        () => readOp({ dataFile, sql: 'SELECT * FROM state' }),
        (err) => err instanceof RunQueryError || err instanceof SqlOpRefusalError,
      );
    } finally {
      runsStore.close();
    }
  });

  it('data.sqlite writes do not show up in automations.sqlite', () => {
    const { dataFile, runsStore } = makeApp();
    try {
      const db = new DatabaseSync(dataFile);
      db.exec(
        'CREATE TABLE IF NOT EXISTS bogus_runs (run_id TEXT, value TEXT); INSERT INTO bogus_runs VALUES (?, ?)',
      );
      db.close();
      // The runs store sees only the row it wrote itself.
      const auditRuns = runsStore.listRuns({});
      assert.equal(auditRuns.length, 1);
      assert.equal(auditRuns[0]?.runId, 'r1');
    } finally {
      runsStore.close();
    }
  });

  it('automations.sqlite tables are not exposed via describeOp at the data path', () => {
    const { dataFile, runsStore } = makeApp();
    try {
      // Even SELECTing PRAGMA-style metadata against data.sqlite reveals
      // no audit/state tables.
      const probe = readOp({
        dataFile,
        sql: "SELECT name FROM sqlite_master WHERE type='table'",
      });
      const names = probe.rows.map((r) => (r as { name: string }).name);
      assert.ok(!names.includes('runs'));
      assert.ok(!names.includes('run_nodes'));
      assert.ok(!names.includes('state'));
    } finally {
      runsStore.close();
    }
  });
});
