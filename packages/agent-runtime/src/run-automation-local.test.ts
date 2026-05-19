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
    schedule: '0 * * * *',
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
      schedule: '0 * * * *',
      onFailure: 'alerter',
      history: { keep: { count: 100 } },
    });
    writeHandler(h.appDir, 'flaky', `export default async () => { throw new Error('boom'); };`);
    writeManifest(h.appDir, 'alerter', { schedule: '0 * * * *' });
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

  it('legacy `schedule` manifests still fire end-to-end (back-compat)', async () => {
    const h = makeAppHarness();
    // No trigger field; bare schedule.
    writeManifest(h.appDir, 'legacy', { schedule: '0 * * * *' });
    writeHandler(h.appDir, 'legacy', `export default async () => ({ summary: 'legacy ok' });`);
    const { outcome } = await runAutomationLocal({
      appId: 'app1',
      appDir: h.appDir,
      automationName: 'legacy',
      runsStore: h.store,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.summary, 'legacy ok');
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
