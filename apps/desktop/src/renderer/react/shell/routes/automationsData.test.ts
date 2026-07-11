import { describe, expect, it, vi } from 'vitest';
import {
  buildAutomationViewData,
  buildOverviewData,
  type AutomationFeedEntry,
} from './automationsData.js';

// buildOverviewData is pure; stub the gateway module so importing it doesn't
// run gateway-client-core's load-time window.CentraidApi side-effect. `vi.mock`
// is hoisted above these imports by vitest, so the stub is in place first.
vi.mock('../../../gateway-client.js', () => ({
  listAutomations: vi.fn(),
  listAutomationRuns: vi.fn(),
}));

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

  it('keeps the subtitle consistent with the health tiles — drafts are not "paused"', () => {
    const data = buildOverviewData(
      [row(), row({ id: 'x', ref: 'x/main', enabled: false })],
      [entry()],
    );
    expect(data.subtitle).toContain('1 active');
    expect(data.subtitle).toContain('0 paused');
    expect(data.subtitle).toContain('1 drafts');
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

const GATEWAY_ORIGIN = 'http://127.0.0.1:5173';

describe('buildAutomationViewData', () => {
  it('derives hero + status + 30-day KPIs for a cron automation', () => {
    const recent = Date.now() - 60_000;
    const data = buildAutomationViewData(
      viewRow(),
      [entry({ startedAt: recent, endedAt: recent + 2000 }).run],
      GATEWAY_ORIGIN,
    );
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
      GATEWAY_ORIGIN,
    );
    expect(data?.kindEyebrow).toBe('Webhook');
    expect(data?.webhook).toEqual({ pending: true, url: null });
    expect(data?.kpis.total).toBe('0');
  });

  it('derives an absolute webhook URL off the gateway origin once provisioned', () => {
    const data = buildAutomationViewData(
      viewRow({ triggers: [{ kind: 'webhook', id: 'abc123' } as never] }),
      [],
      GATEWAY_ORIGIN,
    );
    expect(data?.webhook).toEqual({
      pending: false,
      url: 'http://127.0.0.1:5173/_centraid-hook/abc123',
    });
  });

  it('labels data/condition triggers honestly instead of "Cron schedule"/"Manual only"', () => {
    const dataTrig = buildAutomationViewData(
      viewRow({ triggers: [{ kind: 'data', entities: ['core.content_derivative'] } as never] }),
      [],
      GATEWAY_ORIGIN,
    );
    expect(dataTrig?.kindEyebrow).toBe('Data trigger');
    expect(dataTrig?.when).toBe('On data changes');

    const condTrig = buildAutomationViewData(
      viewRow({ triggers: [{ kind: 'condition', entity: 'core.event' } as never] }),
      [],
      GATEWAY_ORIGIN,
    );
    expect(condTrig?.kindEyebrow).toBe('Condition');
    expect(condTrig?.when).toBe('On condition');

    const manual = buildAutomationViewData(viewRow({ triggers: [] }), [], GATEWAY_ORIGIN);
    expect(manual?.kindEyebrow).toBe('Manual');
    expect(manual?.when).toBe('Manual only');
  });

  it('labels a data-origin run "Data" in the run rows', () => {
    const data = buildAutomationViewData(
      viewRow(),
      [entry({ triggerKind: 'scheduled', triggerOrigin: 'data' } as never).run],
      GATEWAY_ORIGIN,
    );
    expect(data?.runs[0]?.trigLabel).toBe('Data');
  });
});
