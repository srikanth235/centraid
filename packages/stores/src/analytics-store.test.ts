import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAnalyticsDbProvider, type RunSummary } from '@centraid/app-engine';
import { AnalyticsStore } from './analytics-store.js';

function store(): AnalyticsStore {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-analytics-'));
  return new AnalyticsStore(makeAnalyticsDbProvider(join(dir, 'analytics.sqlite')));
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r1',
    kind: 'automation',
    automationRef: 'auto.todos/digest',
    appId: 'auto.todos',
    trigger: 'manual',
    ok: true,
    model: 'claude-sonnet-4-5',
    startedAt: 1_000,
    endedAt: 1_200,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: 0.01,
    ...over,
  };
}

describe('AnalyticsStore', () => {
  it('records and reads back a run summary', () => {
    const s = store();
    s.recordRunSummary(summary());
    const got = s.getSummary('r1');
    assert.equal(got?.automationRef, 'auto.todos/digest');
    assert.equal(got?.appId, 'auto.todos');
    assert.equal(got?.ok, true);
    assert.equal(got?.totalInputTokens, 100);
    assert.equal(got?.model, 'claude-sonnet-4-5');
  });

  it('upserts on a repeated run id', () => {
    const s = store();
    s.recordRunSummary(summary({ ok: true }));
    s.recordRunSummary(summary({ ok: false, error: 'boom' }));
    const got = s.getSummary('r1');
    assert.equal(got?.ok, false);
    assert.equal(got?.error, 'boom');
    assert.equal(s.listSummaries().length, 1);
  });

  it('lists summaries newest-first, optionally scoped to one automation', () => {
    const s = store();
    s.recordRunSummary(summary({ runId: 'r1', automationRef: 'auto.a/job', startedAt: 100 }));
    s.recordRunSummary(summary({ runId: 'r2', automationRef: 'auto.b/job', startedAt: 300 }));
    s.recordRunSummary(summary({ runId: 'r3', automationRef: 'auto.a/job', startedAt: 200 }));
    assert.deepEqual(
      s.listSummaries().map((r) => r.runId),
      ['r2', 'r3', 'r1'],
    );
    assert.deepEqual(
      s.listSummaries({ automationRef: 'auto.a/job' }).map((r) => r.runId),
      ['r3', 'r1'],
    );
  });

  it('mirrors a pin flag and deletes by automation handle', () => {
    const s = store();
    s.recordRunSummary(summary({ runId: 'r1', automationRef: 'auto.a/job' }));
    s.recordRunSummary(summary({ runId: 'r2', automationRef: 'auto.b/job' }));
    assert.equal(s.getSummary('r1')?.pinned, false);
    s.setPinned('r1', true);
    assert.equal(s.getSummary('r1')?.pinned, true);
    s.deleteByRef('auto.a/job');
    assert.equal(s.getSummary('r1'), undefined);
    assert.ok(s.getSummary('r2'), 'unrelated automation untouched');
  });
});
