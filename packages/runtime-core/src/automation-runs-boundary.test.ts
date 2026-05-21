/**
 * Boundary test: the automation run-audit / `ctx.state` surface is NOT
 * reachable from the handler's `db` proxy or the `centraid_sql_*` agent
 * tools (see issue #80 acceptance criterion).
 *
 * The run audit (`automation_runs`, `automation_run_nodes`,
 * `automation_state`) lives in the central gateway DB
 * (`centraid-automations.sqlite`). The `centraid_sql_*` tools — `describeOp`
 * / `readOp` / `writeOp` — only ever receive an app's `data.sqlite`
 * path; they never see the gateway DB path, so the boundary holds even
 * though the audit moved out of a per-app file.
 *
 * This test asserts:
 *   1. `describeOp` over `data.sqlite` does NOT list the automation_*
 *      audit tables even when the gateway DB has been populated.
 *   2. `readOp` over `data.sqlite` errors when asked to SELECT from the
 *      automation_* tables — they don't exist in that file.
 *   3. The `data.sqlite` and gateway DB files are independent: writing
 *      to one does not leak into the other.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AutomationRunsStore } from './automation-runs-store.js';
import { makeAutomationDbProvider } from './gateway-db.js';
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
  // The run audit lives in the gateway DB — a SEPARATE file the
  // centraid_sql_* tools never get a handle to.
  const gatewayDb = path.join(appDir, 'centraid-automations.sqlite');
  const runsStore = new AutomationRunsStore(makeAutomationDbProvider(gatewayDb), 'boundary-app');
  // Seed it so we'd have a leak if the boundary was broken.
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

describe('centraid_sql_* boundary against the automation run audit (issue #80)', () => {
  it('describeOp on data.sqlite hides the automation_* audit tables', () => {
    const { dataFile } = makeApp();
    const result = describeOp({ dataFile });
    const tableNames = result.tables.map((t) => t.name);
    assert.ok(!tableNames.includes('automation_runs'));
    assert.ok(!tableNames.includes('automation_run_nodes'));
    assert.ok(!tableNames.includes('automation_state'));
    assert.ok(tableNames.includes('issues'), 'data.sqlite tables should still be visible');
  });

  it('readOp on data.sqlite cannot SELECT from automation_runs (table not there)', () => {
    const { dataFile } = makeApp();
    assert.throws(
      () => readOp({ dataFile, sql: 'SELECT * FROM automation_runs' }),
      (err) => err instanceof RunQueryError || err instanceof SqlOpRefusalError,
    );
  });

  it('readOp on data.sqlite cannot SELECT from automation_run_nodes or automation_state', () => {
    const { dataFile } = makeApp();
    assert.throws(
      () => readOp({ dataFile, sql: 'SELECT * FROM automation_run_nodes' }),
      (err) => err instanceof RunQueryError || err instanceof SqlOpRefusalError,
    );
    assert.throws(
      () => readOp({ dataFile, sql: 'SELECT * FROM automation_state' }),
      (err) => err instanceof RunQueryError || err instanceof SqlOpRefusalError,
    );
  });

  it('data.sqlite writes do not show up in the run audit', () => {
    const { dataFile, runsStore } = makeApp();
    const db = new DatabaseSync(dataFile);
    db.exec(
      'CREATE TABLE IF NOT EXISTS bogus_runs (run_id TEXT, value TEXT); INSERT INTO bogus_runs VALUES (?, ?)',
    );
    db.close();
    // The runs store sees only the row it wrote itself.
    const auditRuns = runsStore.listRuns({});
    assert.equal(auditRuns.length, 1);
    assert.equal(auditRuns[0]?.runId, 'r1');
  });

  it('the gateway DB audit tables are not exposed via sqlite_master on the data path', () => {
    const { dataFile } = makeApp();
    // Even SELECTing PRAGMA-style metadata against data.sqlite reveals
    // no audit/state tables.
    const probe = readOp({
      dataFile,
      sql: "SELECT name FROM sqlite_master WHERE type='table'",
    });
    const names = probe.rows.map((r) => (r as { name: string }).name);
    assert.ok(!names.includes('automation_runs'));
    assert.ok(!names.includes('automation_run_nodes'));
    assert.ok(!names.includes('automation_state'));
  });
});
