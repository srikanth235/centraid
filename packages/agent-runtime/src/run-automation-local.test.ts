import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AutomationRunsStore,
  automationsDbPath,
  type AutomationManifest,
} from '@centraid/runtime-core';
import { runAutomationLocal } from './run-automation-local.js';

interface AppHarness {
  appDir: string;
  store: AutomationRunsStore;
}

const baseManifest = {
  prompt: 'test',
  action: '',
  requires: {},
  generated: { by: 'test', at: '2026-05-19T00:00:00Z' },
};

function writeManifest(appDir: string, name: string, manifest: Partial<AutomationManifest>): void {
  mkdirSync(path.join(appDir, 'automations'), { recursive: true });
  mkdirSync(path.join(appDir, 'actions'), { recursive: true });
  const full = {
    ...baseManifest,
    trigger: { kind: 'cron', expr: '0 * * * *' },
    action: `${name}.js`,
    ...manifest,
  };
  writeFileSync(
    path.join(appDir, 'automations', `${name}.json`),
    JSON.stringify(full, null, 2),
    'utf8',
  );
}

function writeHandler(appDir: string, name: string, source: string): void {
  mkdirSync(path.join(appDir, 'actions'), { recursive: true });
  writeFileSync(path.join(appDir, 'actions', `${name}.js`), source, 'utf8');
}

function makeAppHarness(): AppHarness {
  const appDir = mkdtempSync(path.join(tmpdir(), 'centraid-local-fire-'));
  const store = new AutomationRunsStore(automationsDbPath(appDir));
  return { appDir, store };
}

describe('runAutomationLocal onFailure cascade (issue #80)', () => {
  it('fires the named onFailure automation with the failed run as input', async () => {
    const h = makeAppHarness();
    writeManifest(h.appDir, 'flaky', {
      onFailure: 'alerter',
      history: { keep: { count: 100 } },
    });
    writeHandler(h.appDir, 'flaky', `export default async () => { throw new Error('boom'); };`);
    writeManifest(h.appDir, 'alerter', {});
    writeHandler(
      h.appDir,
      'alerter',
      `export default async ({ ctx }) => {
        // Surfacing input lets the test verify the cascade wiring.
        return { summary: 'alerted', output: { ok: true } };
      };`,
    );

    const { outcome } = await runAutomationLocal({
      appId: 'app1',
      appDir: h.appDir,
      automationName: 'flaky',
      runsStore: h.store,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /boom/);

    const alerterRuns = h.store.listRuns({ name: 'alerter' });
    assert.equal(alerterRuns.length, 1);
    const alerterRun = alerterRuns[0]!;
    assert.equal(alerterRun.triggerKind, 'on_failure');
    assert.ok(alerterRun.parentRunId);
    const inputPayload = JSON.parse(alerterRun.inputJson ?? '{}') as {
      automationName: string;
      error: string;
    };
    assert.equal(inputPayload.automationName, 'flaky');
    assert.match(inputPayload.error, /boom/);
    h.store.close();
  });

  it('aborts the cascade at depth 3 to prevent infinite loops', async () => {
    const h = makeAppHarness();
    // Two automations forming a cycle: a → b → a → ...
    writeManifest(h.appDir, 'a', { onFailure: 'b' });
    writeHandler(h.appDir, 'a', `export default async () => { throw new Error('a-fail'); };`);
    writeManifest(h.appDir, 'b', { onFailure: 'a' });
    writeHandler(h.appDir, 'b', `export default async () => { throw new Error('b-fail'); };`);

    const logs: Array<{ level: string; msg: string }> = [];
    await runAutomationLocal({
      appId: 'app1',
      appDir: h.appDir,
      automationName: 'a',
      runsStore: h.store,
      onLog: (level, msg) => logs.push({ level, msg }),
    });
    const aCount = h.store.listRuns({ name: 'a' }).length;
    const bCount = h.store.listRuns({ name: 'b' }).length;
    // Initial 'a' fire, depth 1 'b', depth 2 'a', depth 3 'b' — then cap.
    // Total: a fires twice, b fires twice (4 rows). Never more.
    assert.equal(aCount + bCount, 4);
    const aborted = logs.find((l) => l.msg.includes('aborted at depth'));
    assert.ok(aborted, 'expected an abort-at-depth warning');
    h.store.close();
  });

  it('records the runs row + retention runs per history.keep', async () => {
    const h = makeAppHarness();
    writeManifest(h.appDir, 'kept', { history: { keep: { count: 2 } } });
    writeHandler(h.appDir, 'kept', `export default async () => ({ summary: 'ok' });`);
    for (let i = 0; i < 4; i++) {
      await runAutomationLocal({
        appId: 'app1',
        appDir: h.appDir,
        automationName: 'kept',
        runsStore: h.store,
      });
    }
    assert.equal(h.store.countRuns('kept'), 2);
    h.store.close();
  });

  it('outputSchema rejection lands on runs.ok=0 with the validation error', async () => {
    const h = makeAppHarness();
    writeManifest(h.appDir, 'badshape', {
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
    });
    writeHandler(
      h.appDir,
      'badshape',
      `export default async () => ({ output: { count: 'not-a-number' } });`,
    );
    const { outcome } = await runAutomationLocal({
      appId: 'app1',
      appDir: h.appDir,
      automationName: 'badshape',
      runsStore: h.store,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /outputSchema validation failed/);
    const row = h.store.listRuns({ name: 'badshape' })[0];
    assert.equal(row?.ok, false);
    h.store.close();
  });
});

describe('runAutomationLocal pinned-data replay + cross-app invoke (issue #80)', () => {
  it('replay mode serves ctx.tool from a pinned run without spawning a CLI', async () => {
    const h = makeAppHarness();
    writeManifest(h.appDir, 'fetcher', {});
    writeHandler(
      h.appDir,
      'fetcher',
      `export default async ({ ctx }) => {
         const data = await ctx.tool('github.list_prs', { repo: 'foo/bar' });
         return { summary: 'replayed', output: data };
       };`,
    );
    // Seed a pinned run with one recorded tool node.
    h.store.insertRun({
      runId: 'pinned-1',
      automationName: 'fetcher',
      triggerKind: 'scheduled',
      startedAt: 1,
    });
    h.store.finishRun({ runId: 'pinned-1', endedAt: 2, ok: true });
    h.store.insertNode({
      nodeId: 'pn1',
      runId: 'pinned-1',
      ordinal: 0,
      kind: 'tool',
      name: 'github.list_prs',
      argsJson: JSON.stringify({ repo: 'foo/bar' }),
      outputJson: JSON.stringify([{ number: 7 }]),
      ok: true,
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    });
    h.store.setPinned('pinned-1', true);

    const { outcome } = await runAutomationLocal({
      appId: 'app1',
      appDir: h.appDir,
      automationName: 'fetcher',
      runsStore: h.store,
      replayFromRunId: 'pinned-1',
      // A throwing spawnCli proves replay never reaches a CLI subprocess.
      spawnCli: () => {
        throw new Error('replay must not spawn a CLI');
      },
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.output, [{ number: 7 }]);
    const replayRun = h.store.listRuns({ name: 'fetcher' }).find((r) => r.runId !== 'pinned-1');
    assert.equal(replayRun?.triggerKind, 'replay');
    h.store.close();
  });

  it('replay fails loudly when the pin has no matching node', async () => {
    const h = makeAppHarness();
    writeManifest(h.appDir, 'fetcher', {});
    writeHandler(
      h.appDir,
      'fetcher',
      `export default async ({ ctx }) => { await ctx.tool('x.y', {}); };`,
    );
    h.store.insertRun({
      runId: 'empty-pin',
      automationName: 'fetcher',
      triggerKind: 'scheduled',
      startedAt: 1,
    });
    h.store.finishRun({ runId: 'empty-pin', endedAt: 2, ok: true });
    const { outcome } = await runAutomationLocal({
      appId: 'app1',
      appDir: h.appDir,
      automationName: 'fetcher',
      runsStore: h.store,
      replayFromRunId: 'empty-pin',
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /no pinned result/);
    h.store.close();
  });

  it('cross-app ctx.invoke runs a sibling app resolved via resolveApp', async () => {
    const appA = makeAppHarness();
    const appBDir = mkdtempSync(path.join(tmpdir(), 'centraid-local-fire-b-'));
    writeManifest(appA.appDir, 'caller', {});
    writeHandler(
      appA.appDir,
      'caller',
      `export default async ({ ctx }) => {
         const r = await ctx.invoke('appB/worker', { input: { n: 3 } });
         return { output: r };
       };`,
    );
    writeManifest(appBDir, 'worker', {});
    writeHandler(
      appBDir,
      'worker',
      `export default async ({ ctx }) => {
         const inp = ctx.input;
         return { output: { doubled: inp.n * 2 } };
       };`,
    );

    const { outcome } = await runAutomationLocal({
      appId: 'appA',
      appDir: appA.appDir,
      automationName: 'caller',
      runsStore: appA.store,
      resolveApp: (id) => (id === 'appB' ? { appDir: appBDir } : undefined),
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.output, { doubled: 6 });

    // The child ran in appB's own automations.sqlite.
    const appBStore = new AutomationRunsStore(automationsDbPath(appBDir));
    const workerRuns = appBStore.listRuns({ name: 'worker' });
    assert.equal(workerRuns.length, 1);
    assert.equal(workerRuns[0]?.triggerKind, 'manual');
    appBStore.close();

    // The caller recorded the cross-app invoke as a `kind: 'invoke'` node.
    const callerRun = appA.store.listRuns({ name: 'caller' })[0]!;
    const node = appA.store.listNodes(callerRun.runId).find((n) => n.kind === 'invoke');
    assert.ok(node, 'expected an invoke node on the caller run');
    assert.equal(node?.name, 'appB/worker');
    appA.store.close();
  });

  it('cross-app ctx.invoke fails clearly when resolveApp is not wired', async () => {
    const h = makeAppHarness();
    writeManifest(h.appDir, 'caller', {});
    writeHandler(
      h.appDir,
      'caller',
      `export default async ({ ctx }) => { await ctx.invoke('other/thing', {}); };`,
    );
    const { outcome } = await runAutomationLocal({
      appId: 'app1',
      appDir: h.appDir,
      automationName: 'caller',
      runsStore: h.store,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /cross-app invoke requires/);
    h.store.close();
  });
});
