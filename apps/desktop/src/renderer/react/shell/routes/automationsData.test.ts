import { describe, expect, it, vi } from 'vitest';

// buildOverviewData is pure; stub the gateway module so importing it doesn't
// run gateway-client-core's load-time window.CentraidApi side-effect.
vi.mock('../../../gateway-client.js', () => ({
  listAutomations: vi.fn(),
  listAutomationRuns: vi.fn(),
}));

import {
  buildAutomationViewData,
  buildOverviewData,
  type AutomationFeedEntry,
} from './automationsData.js';

const row = (over: Partial<CentraidAutomationRow> = {}): CentraidAutomationRow =>
  ({
    id: 'digest',
    ref: 'digest/main',
    name: 'Daily Digest',
    enabled: true,
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    manifest: { requires: { mcps: [] } },
    ...over,
  }) as unknown as CentraidAutomationRow;

const entry = (over: Partial<AutomationFeedEntry['run']> = {}): AutomationFeedEntry => ({
  automationId: 'digest/main',
  automationName: 'Daily Digest',
  run: {
    runId: 'r1',
    automationId: 'digest/main',
    startedAt: 1000,
    endedAt: 2000,
    ok: true,
    summary: 'ok',
    triggerKind: 'cron',
    totalInputTokens: 10,
    totalOutputTokens: 5,
    ...over,
  } as unknown as CentraidAutomationRunRecord,
});

describe('buildOverviewData', () => {
  it('counts health buckets across rows', () => {
    const data = buildOverviewData(
      [row(), row({ id: 'x', ref: 'x/main', enabled: false })],
      [entry()],
    );
    expect(data.health.active).toBe(1);
    expect(data.health.paused).toBe(0); // the disabled row has no runs → draft
    expect(data.health.drafts).toBe(1);
    expect(data.health.attention).toBe(0);
  });

  it('flags attention when the last run failed', () => {
    const data = buildOverviewData([row()], [entry({ ok: false, error: 'boom' })]);
    expect(data.health.attention).toBe(1);
    expect(data.runs[0]?.summary).toBe('boom');
    expect(data.runs[0]?.ok).toBe(false);
  });

  it('derives row status + labels from the identity helpers', () => {
    const data = buildOverviewData([row()], [entry()]);
    expect(data.rows[0]?.name).toBe('Daily Digest');
    expect(data.rows[0]?.statusLabel).toBeTruthy();
    expect(data.rows[0]?.lastRunLabel).toContain('Last run');
  });

  it('uses the empty-state subtitle when there are no rows', () => {
    const data = buildOverviewData([], []);
    expect(data.subtitle).toBe('Conversations that run on their own.');
  });
});

const viewRow = (over: Partial<CentraidAutomationRow> = {}): CentraidAutomationRow =>
  ({
    id: 'digest',
    ref: 'digest/main',
    name: 'Daily Digest',
    enabled: true,
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    manifest: { requires: { mcps: [] }, history: { keep: 'forever' } },
    ...over,
  }) as unknown as CentraidAutomationRow;

describe('buildAutomationViewData', () => {
  it('derives hero + status + 30-day KPIs for a cron automation', () => {
    const recent = Date.now() - 60_000;
    const data = buildAutomationViewData(viewRow(), [
      entry({ startedAt: recent, endedAt: recent + 2000 }).run,
    ]);
    expect(data?.name).toBe('Daily Digest');
    expect(data?.kindEyebrow).toBe('Cron schedule');
    expect(data?.heroIcon).toBe('Clock');
    expect(data?.enabled).toBe(true);
    expect(data?.kpis.total).toBe('1');
    expect(data?.runs).toHaveLength(1);
  });

  it('marks a webhook automation and derives a pending webhook when unbound', () => {
    const data = buildAutomationViewData(
      viewRow({ triggers: [{ kind: 'webhook', pending: true } as never] }),
      [],
    );
    expect(data?.kindEyebrow).toBe('Webhook');
    expect(data?.webhook).toEqual({ pending: true, url: null });
    expect(data?.kpis.total).toBe('0');
  });
});
