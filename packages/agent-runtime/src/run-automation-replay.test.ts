import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { AutomationRunsStore, automationsDbPath } from '@centraid/runtime-core';
import { buildReplayDispatchers } from './run-automation-replay.js';

function newStore(): AutomationRunsStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'centraid-replay-'));
  return new AutomationRunsStore(automationsDbPath(dir));
}

const ctx = {
  runId: 'replay',
  appId: 'app',
  automationName: 'a',
  abortSignal: new AbortController().signal,
};

describe('buildReplayDispatchers', () => {
  it('fails loudly on a name miss instead of serving an unrelated node', async () => {
    const store = newStore();
    store.insertRun({ runId: 'pin', automationName: 'a', triggerKind: 'scheduled', startedAt: 1 });
    store.insertNode({
      nodeId: 't1',
      runId: 'pin',
      ordinal: 0,
      kind: 'tool',
      name: 'a.x',
      argsJson: '{}',
      outputJson: JSON.stringify('recorded-a.x'),
      ok: true,
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    });
    const d = buildReplayDispatchers(store, 'pin');
    // Handler was edited to call a different tool — must NOT replay a.x.
    const res = await d.toolDispatcher([{ name: 'b.y', args: {} }], ctx);
    assert.equal(res[0]?.ok, false);
    assert.match(res[0]?.error ?? '', /no pinned result/);
    store.close();
  });

  it('disambiguates same-name tool calls by serialized args', async () => {
    const store = newStore();
    store.insertRun({ runId: 'pin', automationName: 'a', triggerKind: 'scheduled', startedAt: 1 });
    for (const [n, out] of [
      [1, 'one'],
      [2, 'two'],
    ] as const) {
      store.insertNode({
        nodeId: `t${n}`,
        runId: 'pin',
        ordinal: n,
        kind: 'tool',
        name: 'a.x',
        argsJson: JSON.stringify({ n }),
        outputJson: JSON.stringify(out),
        ok: true,
        startedAt: n,
        endedAt: n + 1,
        durationMs: 1,
      });
    }
    const d = buildReplayDispatchers(store, 'pin');
    const res = await d.toolDispatcher([{ name: 'a.x', args: { n: 2 } }], ctx);
    assert.equal(res[0]?.ok, true);
    assert.equal(res[0]?.result, 'two');
    store.close();
  });

  it('disambiguates repeated ctx.invoke of the same target by input', async () => {
    const store = newStore();
    store.insertRun({ runId: 'pin', automationName: 'a', triggerKind: 'scheduled', startedAt: 1 });
    for (const [p, out] of [
      [1, 'childA'],
      [2, 'childB'],
    ] as const) {
      store.insertNode({
        nodeId: `i${p}`,
        runId: 'pin',
        ordinal: p,
        kind: 'invoke',
        name: 'child',
        argsJson: JSON.stringify({ p }),
        outputJson: JSON.stringify(out),
        ok: true,
        startedAt: p,
        endedAt: p + 1,
        durationMs: 1,
      });
    }
    const d = buildReplayDispatchers(store, 'pin');
    const res = await d.invokeDispatcher('child', { input: { p: 2 }, parentRunId: 'pin' }, ctx);
    assert.equal(res.output, 'childB');
    store.close();
  });
});
