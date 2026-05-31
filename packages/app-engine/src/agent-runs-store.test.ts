import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { makeRuntimeDbProvider } from './gateway-db.js';
import { AgentRunsStore } from './agent-runs-store.js';

function newStore(): AgentRunsStore {
  // A temp runtime.sqlite — the provider runs the migrations on first use,
  // creating the chat_sessions / runs / run_nodes / automation_state tables.
  const dir = mkdtempSync(path.join(tmpdir(), 'centraid-runs-store-'));
  const provider = makeRuntimeDbProvider(path.join(dir, 'runtime.sqlite'));
  return new AgentRunsStore(provider);
}

describe('AgentRunsStore', () => {
  it('round-trips a run row including parentRunId, inputJson, summary, outputJson', () => {
    const store = newStore();
    store.insertRun({
      runId: 'parent-1',
      automationId: 'auto-parent',
      triggerKind: 'scheduled',
      startedAt: 50,
    });
    store.finishRun({ runId: 'parent-1', endedAt: 60, ok: true });
    store.insertRun({
      runId: 'r1',
      automationId: 'auto-foo',
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
    assert.equal(row.automationId, 'auto-foo');
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
    const store = newStore();
    store.insertRun({ runId: 'r1', automationId: 'a', triggerKind: 'scheduled', startedAt: 1 });
    store.finishRun({ runId: 'r1', endedAt: 2, ok: false, error: 'boom' });
    const row = store.getRun('r1');
    assert.equal(row?.ok, false);
    assert.equal(row?.error, 'boom');
    store.close();
  });

  it('inserts nodes with batch_id; lists in (ordinal, started_at) order', () => {
    const store = newStore();
    store.insertRun({ runId: 'r', automationId: 'a', triggerKind: 'scheduled', startedAt: 0 });
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
      kind: 'step',
      model: 'claude-opus-4-7',
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
    assert.equal(nodes[2]?.model, 'claude-opus-4-7');
    store.close();
  });

  it('automation_state get/set round-trips across store reopens', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'centraid-runs-store-'));
    const provider = makeRuntimeDbProvider(path.join(dir, 'runtime.sqlite'));
    const s1 = new AgentRunsStore(provider);
    s1.stateSet('auto-foo', 'cursor', JSON.stringify({ since: 42 }), 1000);
    s1.close();
    const s2 = new AgentRunsStore(provider);
    const entry = s2.stateGet('auto-foo', 'cursor');
    assert.equal(entry?.valueJson, JSON.stringify({ since: 42 }));
    assert.equal(entry?.updatedAt, 1000);
    s2.stateSet('auto-foo', 'cursor', JSON.stringify({ since: 99 }), 2000);
    const updated = s2.stateGet('auto-foo', 'cursor');
    assert.equal(updated?.valueJson, JSON.stringify({ since: 99 }));
    assert.equal(updated?.updatedAt, 2000);
    s2.stateDelete('auto-foo', 'cursor');
    assert.equal(s2.stateGet('auto-foo', 'cursor'), undefined);
    s2.close();
  });

  it('state is scoped per automation', () => {
    const store = newStore();
    store.stateSet('auto-a', 'k', JSON.stringify('A'), 1);
    store.stateSet('auto-b', 'k', JSON.stringify('B'), 1);
    assert.equal(store.stateGet('auto-a', 'k')?.valueJson, JSON.stringify('A'));
    assert.equal(store.stateGet('auto-b', 'k')?.valueJson, JSON.stringify('B'));
  });

  it('listRuns scopes to a single automation when automationId is given', () => {
    const store = newStore();
    store.insertRun({
      runId: 'a1',
      automationId: 'auto-a',
      triggerKind: 'scheduled',
      startedAt: 1,
    });
    store.insertRun({
      runId: 'b1',
      automationId: 'auto-b',
      triggerKind: 'scheduled',
      startedAt: 2,
    });
    assert.deepEqual(
      store.listRuns({ automationId: 'auto-a' }).map((r) => r.runId),
      ['a1'],
    );
    // No automationId — the ledger is global, so every run is returned.
    assert.deepEqual(
      store.listRuns({}).map((r) => r.runId),
      ['b1', 'a1'],
    );
  });

  it('lastRun returns most recent run, optionally filtered by status', () => {
    const store = newStore();
    store.insertRun({ runId: 'r1', automationId: 'foo', triggerKind: 'scheduled', startedAt: 1 });
    store.finishRun({ runId: 'r1', endedAt: 2, ok: false, error: 'bad' });
    store.insertRun({ runId: 'r2', automationId: 'foo', triggerKind: 'scheduled', startedAt: 3 });
    store.finishRun({ runId: 'r2', endedAt: 4, ok: true });
    store.insertRun({ runId: 'r3', automationId: 'foo', triggerKind: 'scheduled', startedAt: 5 });
    store.finishRun({ runId: 'r3', endedAt: 6, ok: false, error: 'bad2' });
    assert.equal(store.lastRun('foo')?.runId, 'r3');
    assert.equal(store.lastRun('foo', 'ok')?.runId, 'r2');
    assert.equal(store.lastRun('foo', 'error')?.runId, 'r3');
    assert.equal(store.lastRun('missing'), undefined);
    store.close();
  });

  it('listRuns supports automationId/status/since/limit filters', () => {
    const store = newStore();
    for (let i = 0; i < 5; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationId: i < 3 ? 'foo' : 'bar',
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishRun({ runId: id, endedAt: 200 + i, ok: i !== 1 });
    }
    assert.equal(store.listRuns({ automationId: 'foo' }).length, 3);
    assert.equal(store.listRuns({ automationId: 'foo', status: 'ok' }).length, 2);
    assert.equal(store.listRuns({ automationId: 'foo', status: 'error' }).length, 1);
    assert.equal(store.listRuns({ since: 103 }).length, 2);
    assert.equal(store.listRuns({ limit: 2 }).length, 2);
    const newestFirst = store.listRuns({});
    assert.deepEqual(
      newestFirst.map((r) => r.runId),
      ['r4', 'r3', 'r2', 'r1', 'r0'],
    );
    store.close();
  });

  it('listRuns pushes status into SQL so the limit window does not hide older oks', () => {
    const store = newStore();
    // r0,r1 succeed (oldest); r2,r3,r4 fail (newest).
    for (let i = 0; i < 5; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationId: 'win',
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishRun({ runId: id, endedAt: 200 + i, ok: i < 2 });
    }
    const oks = store.listRuns({ automationId: 'win', status: 'ok', limit: 2 });
    assert.equal(oks.length, 2);
    assert.deepEqual(
      oks.map((r) => r.runId),
      ['r1', 'r0'],
    );
    store.close();
  });

  it('prune by count keeps newest N runs and cascades nodes', () => {
    const store = newStore();
    for (let i = 0; i < 10; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationId: 'foo',
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
    const remaining = store.listRuns({ automationId: 'foo' }).map((r) => r.runId);
    assert.deepEqual(remaining, ['r9', 'r8', 'r7']);
    for (let i = 0; i < 7; i++) {
      assert.equal(store.listNodes(`r${i}`).length, 0);
    }
    for (let i = 7; i < 10; i++) {
      assert.equal(store.listNodes(`r${i}`).length, 1);
    }
    store.close();
  });

  it('prune errorsOnly drops successful runs', () => {
    const store = newStore();
    for (let i = 0; i < 4; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationId: 'foo',
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishRun({ runId: id, endedAt: 200 + i, ok: i % 2 === 0, error: 'x' });
    }
    store.prune('foo', { errorsOnly: true });
    const remaining = store.listRuns({ automationId: 'foo' });
    assert.equal(remaining.length, 2);
    for (const r of remaining) assert.equal(r.ok, false);
    store.close();
  });

  it('prune all=true is a no-op', () => {
    const store = newStore();
    store.insertRun({ runId: 'r1', automationId: 'foo', triggerKind: 'scheduled', startedAt: 1 });
    store.finishRun({ runId: 'r1', endedAt: 2, ok: true });
    store.prune('foo', { all: true });
    assert.equal(store.countRuns('foo'), 1);
    store.close();
  });

  it('setPinned / pinnedRun round-trip; pinned runs survive count pruning', () => {
    const store = newStore();
    for (let i = 0; i < 6; i++) {
      const id = `r${i}`;
      store.insertRun({
        runId: id,
        automationId: 'foo',
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishRun({ runId: id, endedAt: 200 + i, ok: true });
    }
    assert.equal(store.getRun('r0')?.pinned, false);
    store.setPinned('r0', true);
    assert.equal(store.getRun('r0')?.pinned, true);
    assert.equal(store.pinnedRun('foo')?.runId, 'r0');
    store.prune('foo', { count: 2 });
    const remaining = store.listRuns({ automationId: 'foo' }).map((r) => r.runId);
    assert.ok(remaining.includes('r0'), 'pinned run must survive count pruning');
    assert.equal(remaining.length, 3); // r0 (pinned) + r5 + r4
    store.setPinned('r0', false);
    assert.equal(store.pinnedRun('foo'), undefined);
    store.close();
  });

  it('insertNode records child_run_id; listChildRuns links parent to children', () => {
    const store = newStore();
    store.insertRun({ runId: 'p', automationId: 'parent', triggerKind: 'scheduled', startedAt: 0 });
    store.insertRun({
      runId: 'c1',
      automationId: 'child',
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

  it('deleteAutomationData drops only that automation run ledger + state', () => {
    const store = newStore();
    for (const id of ['a1', 'b1']) {
      const automationId = id === 'a1' ? 'auto-a' : 'auto-b';
      store.insertRun({ runId: id, automationId, triggerKind: 'scheduled', startedAt: 1 });
      store.insertNode({
        nodeId: `${id}-n`,
        runId: id,
        ordinal: 0,
        kind: 'tool',
        name: 't',
        ok: true,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      });
      store.stateSet(automationId, 'k', JSON.stringify('v'), 1);
    }
    store.deleteAutomationData('auto-a');
    assert.equal(store.listRuns({ automationId: 'auto-a' }).length, 0);
    assert.equal(store.listNodes('a1').length, 0); // cascaded
    assert.equal(store.stateGet('auto-a', 'k'), undefined);
    // auto-b is untouched.
    assert.equal(store.listRuns({ automationId: 'auto-b' }).length, 1);
    assert.equal(store.listNodes('b1').length, 1);
    assert.ok(store.stateGet('auto-b', 'k'));
  });
});
