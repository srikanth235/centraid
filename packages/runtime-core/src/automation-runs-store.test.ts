import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import { AutomationRunsStore } from './automation-runs-store.js';
import {
  automationsDbPath,
  openAutomationsDb,
  AUTOMATIONS_DB_FILE,
} from './automation-runs-schema.js';

function newStore(): { store: AutomationRunsStore; dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'centraid-runs-store-'));
  const file = automationsDbPath(dir);
  return { store: new AutomationRunsStore(file), dir, file };
}

describe('AutomationRunsStore', () => {
  it('does not create the file until first method call', () => {
    const { dir, file } = newStore();
    assert.equal(existsSync(file), false);
    assert.equal(path.basename(file), AUTOMATIONS_DB_FILE);
    assert.equal(path.dirname(file), dir);
  });

  it('creates the file lazily on first insertRun', () => {
    const { store, file } = newStore();
    store.insertRun({
      runId: 'r1',
      automationName: 'foo',
      triggerKind: 'scheduled',
      startedAt: 1000,
    });
    assert.equal(existsSync(file), true);
    store.close();
  });

  it('round-trips a run row including parentRunId, inputJson, summary, outputJson', () => {
    const { store } = newStore();
    store.insertRun({
      runId: 'parent-1',
      automationName: 'parent',
      triggerKind: 'scheduled',
      startedAt: 50,
    });
    store.finishRun({ runId: 'parent-1', endedAt: 60, ok: true });
    store.insertRun({
      runId: 'r1',
      automationName: 'foo',
      triggerKind: 'manual',
      parentRunId: 'parent-1',
      inputJson: '{"a":1}',
      startedAt: 100,
    });
    store.finishRun({
      runId: 'r1',
      endedAt: 200,
      ok: true,
      summary: 'did the thing',
      outputJson: '{"k":"v"}',
    });
    const row = store.getRun('r1');
    assert.ok(row);
    assert.equal(row.runId, 'r1');
    assert.equal(row.triggerKind, 'manual');
    assert.equal(row.parentRunId, 'parent-1');
    assert.equal(row.inputJson, '{"a":1}');
    assert.equal(row.startedAt, 100);
    assert.equal(row.endedAt, 200);
    assert.equal(row.ok, true);
    assert.equal(row.summary, 'did the thing');
    assert.equal(row.outputJson, '{"k":"v"}');
    store.close();
  });

  it('finishRun with ok=false records the error', () => {
    const { store } = newStore();
    store.insertRun({
      runId: 'r1',
      automationName: 'foo',
      triggerKind: 'scheduled',
      startedAt: 1,
    });
    store.finishRun({ runId: 'r1', endedAt: 2, ok: false, error: 'boom' });
    const row = store.getRun('r1');
    assert.equal(row?.ok, false);
    assert.equal(row?.error, 'boom');
    store.close();
  });

  it('inserts nodes with batch_id; lists in (ordinal, started_at) order', () => {
    const { store } = newStore();
    store.insertRun({ runId: 'r', automationName: 'foo', triggerKind: 'scheduled', startedAt: 0 });
    store.insertNode({
      nodeId: 'n1',
      runId: 'r',
      ordinal: 0,
      batchId: 1,
      kind: 'tool',
      name: 'github.list_prs',
      ok: true,
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
    });
    store.insertNode({
      nodeId: 'n2',
      runId: 'r',
      ordinal: 1,
      batchId: 1,
      kind: 'tool',
      name: 'github.list_issues',
      ok: true,
      startedAt: 11,
      endedAt: 21,
      durationMs: 10,
    });
    store.insertNode({
      nodeId: 'n3',
      runId: 'r',
      ordinal: 2,
      kind: 'agent',
      name: 'agent',
      ok: true,
      startedAt: 30,
      endedAt: 40,
      durationMs: 10,
    });
    const nodes = store.listNodes('r');
    assert.equal(nodes.length, 3);
    assert.deepEqual(
      nodes.map((n) => [n.nodeId, n.ordinal]),
      [
        ['n1', 0],
        ['n2', 1],
        ['n3', 2],
      ],
    );
    assert.equal(nodes[0]?.batchId, 1);
    assert.equal(nodes[1]?.batchId, 1);
    assert.equal(nodes[2]?.batchId, undefined);
    store.close();
  });

  it('ctx.state get/set round-trip across reopens', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'centraid-runs-store-'));
    const file = automationsDbPath(dir);
    const s1 = new AutomationRunsStore(file);
    s1.stateSet('foo', 'cursor', JSON.stringify({ since: 42 }), 1000);
    s1.close();
    const s2 = new AutomationRunsStore(file);
    const entry = s2.stateGet('foo', 'cursor');
    assert.equal(entry?.valueJson, JSON.stringify({ since: 42 }));
    assert.equal(entry?.updatedAt, 1000);
    s2.stateSet('foo', 'cursor', JSON.stringify({ since: 99 }), 2000);
    const updated = s2.stateGet('foo', 'cursor');
    assert.equal(updated?.valueJson, JSON.stringify({ since: 99 }));
    assert.equal(updated?.updatedAt, 2000);
    s2.stateDelete('foo', 'cursor');
    assert.equal(s2.stateGet('foo', 'cursor'), undefined);
    s2.close();
  });

  it('lastRun returns most recent run, optionally filtered by status', () => {
    const { store } = newStore();
    store.insertRun({ runId: 'r1', automationName: 'foo', triggerKind: 'scheduled', startedAt: 1 });
    store.finishRun({ runId: 'r1', endedAt: 2, ok: false, error: 'bad' });
    store.insertRun({ runId: 'r2', automationName: 'foo', triggerKind: 'scheduled', startedAt: 3 });
    store.finishRun({ runId: 'r2', endedAt: 4, ok: true });
    store.insertRun({ runId: 'r3', automationName: 'foo', triggerKind: 'scheduled', startedAt: 5 });
    store.finishRun({ runId: 'r3', endedAt: 6, ok: false, error: 'bad2' });
    assert.equal(store.lastRun('foo')?.runId, 'r3');
    assert.equal(store.lastRun('foo', 'ok')?.runId, 'r2');
    assert.equal(store.lastRun('foo', 'error')?.runId, 'r3');
    assert.equal(store.lastRun('missing'), undefined);
    store.close();
  });

  it('listRuns supports name/status/since/limit filters', () => {
    const { store } = newStore();
    for (let i = 0; i < 5; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationName: i < 3 ? 'foo' : 'bar',
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishRun({ runId: id, endedAt: 200 + i, ok: i !== 1 });
    }
    assert.equal(store.listRuns({ name: 'foo' }).length, 3);
    assert.equal(store.listRuns({ name: 'foo', status: 'ok' }).length, 2);
    assert.equal(store.listRuns({ name: 'foo', status: 'error' }).length, 1);
    assert.equal(store.listRuns({ since: 103 }).length, 2);
    assert.equal(store.listRuns({ limit: 2 }).length, 2);
    const newestFirst = store.listRuns({});
    assert.deepEqual(
      newestFirst.map((r) => r.runId),
      ['r4', 'r3', 'r2', 'r1', 'r0'],
    );
    store.close();
  });

  it('prune by count keeps newest N runs and cascades nodes', () => {
    const { store } = newStore();
    for (let i = 0; i < 10; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationName: 'foo',
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishRun({ runId: id, endedAt: 200 + i, ok: true });
      store.insertNode({
        nodeId: `n-${i}`,
        runId: id,
        ordinal: 0,
        kind: 'tool',
        name: 'a.b',
        ok: true,
        startedAt: 150 + i,
        endedAt: 151 + i,
        durationMs: 1,
      });
    }
    assert.equal(store.countRuns('foo'), 10);
    store.prune('foo', { count: 3 });
    assert.equal(store.countRuns('foo'), 3);
    const remaining = store.listRuns({ name: 'foo' }).map((r) => r.runId);
    assert.deepEqual(remaining, ['r9', 'r8', 'r7']);
    // Nodes for pruned runs are cascaded away.
    for (let i = 0; i < 7; i++) {
      assert.equal(store.listNodes(`r${i}`).length, 0);
    }
    for (let i = 7; i < 10; i++) {
      assert.equal(store.listNodes(`r${i}`).length, 1);
    }
    store.close();
  });

  it('prune errorsOnly drops successful runs', () => {
    const { store } = newStore();
    for (let i = 0; i < 4; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationName: 'foo',
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishRun({ runId: id, endedAt: 200 + i, ok: i % 2 === 0, error: 'x' });
    }
    store.prune('foo', { errorsOnly: true });
    const remaining = store.listRuns({ name: 'foo' });
    assert.equal(remaining.length, 2);
    for (const r of remaining) assert.equal(r.ok, false);
    store.close();
  });

  it('prune all=true is a no-op', () => {
    const { store } = newStore();
    store.insertRun({ runId: 'r1', automationName: 'foo', triggerKind: 'scheduled', startedAt: 1 });
    store.finishRun({ runId: 'r1', endedAt: 2, ok: true });
    store.prune('foo', { all: true });
    assert.equal(store.countRuns('foo'), 1);
    store.close();
  });

  it('migrate is idempotent — opening an already-current DB does nothing', () => {
    const { file } = newStore();
    const db1 = openAutomationsDb(file);
    db1.close();
    const db2 = openAutomationsDb(file);
    const version = (
      db2.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    )?.user_version;
    assert.equal(version, 2);
    db2.close();
  });

  it('setPinned / pinnedRun round-trip; pinned runs survive count pruning', () => {
    const { store } = newStore();
    for (let i = 0; i < 6; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationName: 'foo',
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishRun({ runId: id, endedAt: 200 + i, ok: true });
    }
    assert.equal(store.getRun('r0')?.pinned, false);
    store.setPinned('r0', true);
    assert.equal(store.getRun('r0')?.pinned, true);
    assert.equal(store.pinnedRun('foo')?.runId, 'r0');
    // Keep newest 2 — r0 is oldest but pinned, so it must survive.
    store.prune('foo', { count: 2 });
    const remaining = store.listRuns({ name: 'foo' }).map((r) => r.runId);
    assert.ok(remaining.includes('r0'), 'pinned run must survive count pruning');
    assert.equal(remaining.length, 3); // r0 (pinned) + r5 + r4
    store.setPinned('r0', false);
    assert.equal(store.pinnedRun('foo'), undefined);
    store.close();
  });

  it('insertNode records child_run_id; listChildRuns links parent to children', () => {
    const { store } = newStore();
    store.insertRun({
      runId: 'p',
      automationName: 'parent',
      triggerKind: 'scheduled',
      startedAt: 0,
    });
    store.insertRun({
      runId: 'c1',
      automationName: 'child',
      triggerKind: 'manual',
      parentRunId: 'p',
      startedAt: 5,
    });
    store.insertNode({
      nodeId: 'n1',
      runId: 'p',
      ordinal: 0,
      kind: 'invoke',
      name: 'child',
      childRunId: 'c1',
      ok: true,
      startedAt: 5,
      endedAt: 9,
      durationMs: 4,
    });
    assert.equal(store.listNodes('p')[0]?.childRunId, 'c1');
    assert.equal(store.listNodes('p')[0]?.kind, 'invoke');
    const children = store.listChildRuns('p');
    assert.equal(children.length, 1);
    assert.equal(children[0]?.runId, 'c1');
    assert.equal(store.listChildRuns('missing').length, 0);
    store.close();
  });
});
