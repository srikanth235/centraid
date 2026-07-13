import { describe, expect, it, vi } from 'vitest';
import {
  buildOverviewData,
  collectAutomationRuns,
  deriveAutomationHero,
  triggerOriginLabel,
  type AutomationFeedEntry,
} from './automationsData.js';
import { listAutomationRuns, listAutomations } from '../../../gateway-client.js';

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

  it('projects compile lifecycle labels into the fleet row', () => {
    const compiling = buildOverviewData(
      [row({ enabled: false })],
      [entry({ endedAt: undefined, ok: false, triggerKind: 'compile' } as never)],
    );
    expect(compiling.rows[0]).toMatchObject({ statusKind: 'running', statusLabel: 'Compiling…' });
    expect(compiling.rows[0]?.lastRunOk).toBeNull();

    const ready = buildOverviewData([row()], [entry({ triggerKind: 'compile' } as never)]);
    expect(ready.rows[0]).toMatchObject({ statusKind: 'success', statusLabel: 'Plan ready' });

    const failed = buildOverviewData(
      [row({ enabled: false })],
      [entry({ error: 'no plan', ok: false, triggerKind: 'compile' } as never)],
    );
    expect(failed.rows[0]).toMatchObject({ statusKind: 'failed', statusLabel: 'Compile failed' });
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

  it("Title-Cases the trigger origin in a run's metaLabel instead of the raw enum", () => {
    const dataRun = buildOverviewData(
      [row()],
      [entry({ triggerKind: 'scheduled', triggerOrigin: 'data' } as never)],
    );
    expect(dataRun.runs[0]?.metaLabel).toMatch(/^Data · /);
    expect(dataRun.runs[0]?.metaLabel).not.toContain('data ·');

    const webhookRun = buildOverviewData(
      [row()],
      [entry({ triggerKind: 'scheduled', triggerOrigin: 'webhook' } as never)],
    );
    expect(webhookRun.runs[0]?.metaLabel).toMatch(/^Webhook · /);

    const manualRun = buildOverviewData(
      [row()],
      [entry({ triggerKind: 'manual', triggerOrigin: undefined } as never)],
    );
    expect(manualRun.runs[0]?.metaLabel).toMatch(/^Manual · /);

    const cronRun = buildOverviewData(
      [row()],
      [entry({ triggerKind: 'scheduled', triggerOrigin: undefined } as never)],
    );
    expect(cronRun.runs[0]?.metaLabel).toMatch(/^Cron · /);
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

describe('deriveAutomationHero', () => {
  it('derives the cron hero (eyebrow, icon, next runs off the expr)', () => {
    const hero = deriveAutomationHero(viewRow(), GATEWAY_ORIGIN);
    expect(hero.kindEyebrow).toBe('Cron schedule');
    expect(hero.heroIcon).toBe('Clock');
    expect(hero.cronExprs).toEqual(['0 9 * * *']);
    expect(hero.nextRuns).toHaveLength(3);
  });

  it('marks a webhook automation and derives a pending webhook when unbound', () => {
    const hero = deriveAutomationHero(
      viewRow({ triggers: [{ kind: 'webhook', pending: true } as never] }),
      GATEWAY_ORIGIN,
    );
    expect(hero.kindEyebrow).toBe('Webhook');
    expect(hero.webhook).toEqual({ pending: true, url: null });
  });

  it('derives an absolute webhook URL off the gateway origin once provisioned', () => {
    const hero = deriveAutomationHero(
      viewRow({ triggers: [{ kind: 'webhook', id: 'abc123' } as never] }),
      GATEWAY_ORIGIN,
    );
    expect(hero.webhook).toEqual({
      pending: false,
      url: 'http://127.0.0.1:5173/_centraid-hook/abc123',
    });
  });

  it('labels data/condition triggers honestly instead of "Cron schedule"/"Manual only"', () => {
    const dataTrig = deriveAutomationHero(
      viewRow({ triggers: [{ kind: 'data', entities: ['core.content_derivative'] } as never] }),
      GATEWAY_ORIGIN,
    );
    expect(dataTrig.kindEyebrow).toBe('Data trigger');
    expect(dataTrig.when).toBe('On data changes');

    const condTrig = deriveAutomationHero(
      viewRow({ triggers: [{ kind: 'condition', entity: 'core.event' } as never] }),
      GATEWAY_ORIGIN,
    );
    expect(condTrig.kindEyebrow).toBe('Condition');
    expect(condTrig.when).toBe('On condition');

    const manual = deriveAutomationHero(viewRow({ triggers: [] }), GATEWAY_ORIGIN);
    expect(manual.kindEyebrow).toBe('Manual');
    expect(manual.when).toBe('Manual only');
  });

  it('labels a data-origin run "Data"', () => {
    const trig = triggerOriginLabel(
      entry({ triggerKind: 'scheduled', triggerOrigin: 'data' } as never).run,
    );
    expect(trig.label).toBe('Data');
  });

  it('derives dataDetail (entities + cadence) for a data trigger', () => {
    const withEvery = deriveAutomationHero(
      viewRow({
        triggers: [
          {
            kind: 'data',
            entities: ['core.content_derivative', 'core.event'],
            every: '5m',
          } as never,
        ],
      }),
      GATEWAY_ORIGIN,
    );
    expect(withEvery.dataDetail).toEqual({
      entities: ['core.content_derivative', 'core.event'],
      everyLabel: 'Every 5m',
    });
    expect(withEvery.conditionDetail).toBeNull();

    const withoutEvery = deriveAutomationHero(
      viewRow({ triggers: [{ kind: 'data', entities: ['core.event'] } as never] }),
      GATEWAY_ORIGIN,
    );
    expect(withoutEvery.dataDetail).toEqual({ entities: ['core.event'], everyLabel: null });
  });

  it('derives conditionDetail with a readable where clause for a structured condition', () => {
    const hero = deriveAutomationHero(
      viewRow({
        triggers: [
          {
            kind: 'condition',
            entity: 'core.event',
            where: { status: 'overdue' },
            every: '1h',
          } as never,
        ],
      }),
      GATEWAY_ORIGIN,
    );
    expect(hero.conditionDetail).toEqual({
      entity: 'core.event',
      whereText: JSON.stringify({ status: 'overdue' }, null, 2),
      everyLabel: 'Every 1h',
    });
    expect(hero.dataDetail).toBeNull();
  });

  it('passes a plain-string where clause through unchanged', () => {
    const hero = deriveAutomationHero(
      viewRow({
        triggers: [{ kind: 'condition', entity: 'core.event', where: 'status = overdue' } as never],
      }),
      GATEWAY_ORIGIN,
    );
    expect(hero.conditionDetail?.whereText).toBe('status = overdue');
  });

  it('renders a structured where clause array as compact "column op value" lines, matching the builder', () => {
    const hero = deriveAutomationHero(
      viewRow({
        triggers: [
          {
            kind: 'condition',
            entity: 'core.event',
            where: [
              { column: 'status', op: 'eq', value: 'open' },
              { column: 'days_left', op: 'within-days', value: 3 },
            ],
          } as never,
        ],
      }),
      GATEWAY_ORIGIN,
    );
    expect(hero.conditionDetail?.whereText).toBe('status eq "open"\ndays_left within-days 3');
  });

  it('is null for both dataDetail and conditionDetail on a cron automation', () => {
    const hero = deriveAutomationHero(viewRow(), GATEWAY_ORIGIN);
    expect(hero.dataDetail).toBeNull();
    expect(hero.conditionDetail).toBeNull();
  });
});

describe('collectAutomationRuns', () => {
  it('prefers the live automation name over the run-recorded name over the raw ref', async () => {
    vi.mocked(listAutomations).mockResolvedValue([row()] as unknown as CentraidAutomationRow[]);
    vi.mocked(listAutomationRuns).mockResolvedValue([
      entry({ automationId: 'digest/main' }).run,
    ] as unknown as CentraidAutomationRunRecord[]);
    const entries = await collectAutomationRuns();
    expect(entries[0]?.automationName).toBe('Daily Digest');
  });

  it('falls back to the run-recorded name when the automation was deleted', async () => {
    vi.mocked(listAutomations).mockResolvedValue([] as unknown as CentraidAutomationRow[]);
    vi.mocked(listAutomationRuns).mockResolvedValue([
      {
        runId: 'r1',
        automationId: 'gone-app/gone-auto',
        automationName: 'Gone Automation',
        startedAt: 1000,
        ok: true,
        triggerKind: 'cron',
      },
    ] as unknown as CentraidAutomationRunRecord[]);
    const entries = await collectAutomationRuns();
    expect(entries[0]?.automationName).toBe('Gone Automation');
  });

  it('falls back to the raw ref when neither the automation nor a recorded name exists', async () => {
    vi.mocked(listAutomations).mockResolvedValue([] as unknown as CentraidAutomationRow[]);
    vi.mocked(listAutomationRuns).mockResolvedValue([
      {
        runId: 'r1',
        automationId: 'gone-app/gone-auto',
        startedAt: 1000,
        ok: true,
        triggerKind: 'cron',
      },
    ] as unknown as CentraidAutomationRunRecord[]);
    const entries = await collectAutomationRuns();
    expect(entries[0]?.automationName).toBe('gone-app/gone-auto');
  });
});
