import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunSummary } from '../conversation/run-summary-sink.js';
import { makeJournalDbProvider } from '../stores/gateway-db.js';
import { AnalyticsStore } from './analytics-store.js';

function store(): AnalyticsStore {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-analytics-'));
  return new AnalyticsStore(makeJournalDbProvider(join(dir, 'journal.db')));
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
    expect(got?.automationRef).toBe('auto.todos/digest');
    expect(got?.appId).toBe('auto.todos');
    expect(got?.ok).toBe(true);
    expect(got?.totalInputTokens).toBe(100);
    expect(got?.model).toBe('claude-sonnet-4-5');
  });

  it('upserts on a repeated run id', () => {
    const s = store();
    s.recordRunSummary(summary({ ok: true }));
    s.recordRunSummary(summary({ ok: false, error: 'boom' }));
    const got = s.getSummary('r1');
    expect(got?.ok).toBe(false);
    expect(got?.error).toBe('boom');
    expect(s.listSummaries().length).toBe(1);
  });

  it('lists summaries newest-first, optionally scoped to one automation', () => {
    const s = store();
    s.recordRunSummary(summary({ runId: 'r1', automationRef: 'auto.a/job', startedAt: 100 }));
    s.recordRunSummary(summary({ runId: 'r2', automationRef: 'auto.b/job', startedAt: 300 }));
    s.recordRunSummary(summary({ runId: 'r3', automationRef: 'auto.a/job', startedAt: 200 }));
    expect(s.listSummaries().map((r) => r.runId)).toEqual(['r2', 'r3', 'r1']);
    expect(s.listSummaries({ automationRef: 'auto.a/job' }).map((r) => r.runId)).toEqual([
      'r3',
      'r1',
    ]);
  });

  it('mirrors a pin flag and deletes by automation handle', () => {
    const s = store();
    s.recordRunSummary(summary({ runId: 'r1', automationRef: 'auto.a/job' }));
    s.recordRunSummary(summary({ runId: 'r2', automationRef: 'auto.b/job' }));
    expect(s.getSummary('r1')?.pinned).toBe(false);
    s.setPinned('r1', true);
    expect(s.getSummary('r1')?.pinned).toBe(true);
    s.deleteByRef('auto.a/job');
    expect(s.getSummary('r1')).toBe(undefined);
    expect(s.getSummary('r2')).toBeTruthy();
  });
});
