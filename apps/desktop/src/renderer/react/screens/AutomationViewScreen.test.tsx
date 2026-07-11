import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationViewBridgeProps, AutomationViewData } from '../screen-contracts.js';
import AutomationViewScreen from './AutomationViewScreen.js';

function makeData(over: Partial<AutomationViewData> = {}): AutomationViewData {
  return {
    name: 'Daily Digest',
    description: 'Summarize the inbox',
    glyphIcon: 'Bolt',
    hue: 'indigo',
    kindEyebrow: 'Cron schedule',
    heroIcon: 'Clock',
    when: 'Every day at 8am',
    cronExprs: ['0 8 * * *'],
    nextRuns: ['Tomorrow', 'In 2 days', 'In 3 days'],
    webhook: null,
    dataDetail: null,
    conditionDetail: null,
    enabled: true,
    statusKind: 'active',
    statusLabel: 'Active',
    runs: [
      {
        runId: 'r1',
        automationId: 'a',
        ok: true,
        summary: 'ok run',
        trigIcon: 'Clock',
        trigLabel: 'Cron',
        whenLabel: '2h ago',
        metaLabel: '3s · 1.2k',
        filterKey: 'cron',
      },
      {
        runId: 'r2',
        automationId: 'a',
        ok: false,
        summary: 'failed run',
        trigIcon: 'Play',
        trigLabel: 'Manual',
        whenLabel: '1d ago',
        metaLabel: '1s · 0.3k',
        filterKey: 'manual',
      },
    ],
    kpis: { total: '12', successPct: '92%', avg: '3s', cost: '$0.40' },
    behavior: { model: 'claude-opus-4-8', historyLabel: 'Keep 30 days', onFailure: 'Stop' },
    tools: ['gmail.search'],
    ...over,
  };
}

function makeProps(over: Partial<AutomationViewBridgeProps> = {}): AutomationViewBridgeProps {
  return {
    loadData: vi.fn().mockResolvedValue(makeData()),
    onBack: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(false),
    onRun: vi.fn().mockResolvedValue(true),
    onToggleEnabled: vi.fn().mockResolvedValue(true),
    onCopyWebhook: vi.fn(),
    onOpenRun: vi.fn(),
    onRegenerateWebhookSecret: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});
async function mount(props: AutomationViewBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationViewScreen {...props} />);
  });
  return container;
}

describe('AutomationViewScreen', () => {
  it('renders header, hero (cron + next runs), KPIs, behavior, tools, and runs', async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('.vtitle h1')?.textContent).toBe('Daily Digest');
    expect(el.textContent).toContain('Every day at 8am');
    expect(el.querySelector('code')?.textContent).toBe('0 8 * * *');
    expect(el.textContent).toContain('Next 3 runs');
    expect(el.querySelectorAll('.kpi').length).toBe(4);
    expect(el.textContent).toContain('claude-opus-4-8');
    expect(el.textContent).toContain('gmail.search');
    expect(el.querySelectorAll('.run').length).toBe(2);
  });

  it('filters the run history', async () => {
    const el = await mount(makeProps());
    const manualFilter = [...el.querySelectorAll('.filter')].find(
      (b) => (b as HTMLElement).dataset.filter === 'manual',
    ) as HTMLButtonElement;
    await act(async () => manualFilter.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelectorAll('.run').length).toBe(1);
    expect(el.textContent).toContain('failed run');
    expect(el.textContent).not.toContain('ok run');
  });

  it('opens a run, edits, and navigates back', async () => {
    const props = makeProps();
    const el = await mount(props);
    await act(async () =>
      (el.querySelector('.run') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onOpenRun).toHaveBeenCalledWith('a', 'r1');
    await act(async () =>
      (el.querySelector('.auCrumb button') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onBack).toHaveBeenCalled();
  });

  it('toggles enabled then reloads on success', async () => {
    const props = makeProps();
    const el = await mount(props);
    const toggle = el.querySelector('.switch input') as HTMLInputElement;
    // .click() flips the checkbox (true→false) and fires the event React's
    // controlled onChange listens to.
    await act(async () => toggle.click());
    expect(props.onToggleEnabled).toHaveBeenCalledWith(false);
    // initial load + reload after successful toggle
    expect(props.loadData).toHaveBeenCalledTimes(2);
  });

  it('runs now, handing off (button shows Starting…)', async () => {
    const props = makeProps({ onRun: vi.fn().mockReturnValue(new Promise(() => {})) });
    const el = await mount(props);
    const runBtn = [...el.querySelectorAll('.auBtnPrimary')].at(-1) as HTMLButtonElement;
    await act(async () => runBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onRun).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Starting…');
  });

  it('shows the webhook URL + copy for a webhook automation', async () => {
    const props = makeProps({
      loadData: vi.fn().mockResolvedValue(
        makeData({
          kindEyebrow: 'Webhook',
          heroIcon: 'Webhook',
          cronExprs: [],
          nextRuns: [],
          webhook: { pending: false, url: '/_centraid-hook/abc' },
        }),
      ),
    });
    const el = await mount(props);
    expect(el.querySelector('.heroWhUrl')?.textContent).toBe('/_centraid-hook/abc');
    await act(async () =>
      (el.querySelector('.heroCopy') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onCopyWebhook).toHaveBeenCalledWith('/_centraid-hook/abc');
  });

  it('renders the not-found state when loadData resolves null, with a working breadcrumb back', async () => {
    const props = makeProps({ loadData: vi.fn().mockResolvedValue(null) });
    const el = await mount(props);
    expect(el.textContent).toContain('Automation not found.');
    const back = el.querySelector('.auCrumb button') as HTMLButtonElement;
    expect(back).toBeTruthy();
    await act(async () => back.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('renders a breadcrumb back affordance in the loading state, before data resolves', async () => {
    const props = makeProps({ loadData: vi.fn().mockReturnValue(new Promise(() => {})) });
    const el = await mount(props);
    expect(el.textContent).toContain('Loading automation…');
    const back = el.querySelector('.auCrumb button') as HTMLButtonElement;
    expect(back).toBeTruthy();
    await act(async () => back.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('renders the error state with a breadcrumb back affordance', async () => {
    const props = makeProps({ loadData: vi.fn().mockRejectedValue(new Error('boom')) });
    const el = await mount(props);
    expect(el.textContent).toContain('Could not load automation.');
    expect(el.querySelector('.auCrumb button')).toBeTruthy();
  });

  it('regenerates the webhook secret and shows "Regenerating…" while in flight', async () => {
    const props = makeProps({
      loadData: vi.fn().mockResolvedValue(
        makeData({
          kindEyebrow: 'Webhook',
          heroIcon: 'Webhook',
          cronExprs: [],
          nextRuns: [],
          webhook: { pending: false, url: '/_centraid-hook/abc' },
        }),
      ),
      onRegenerateWebhookSecret: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const el = await mount(props);
    const regenBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Regenerate secret'),
    ) as HTMLButtonElement;
    expect(regenBtn).toBeTruthy();
    await act(async () => regenBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onRegenerateWebhookSecret).toHaveBeenCalledTimes(1);
    expect(regenBtn.textContent).toContain('Regenerating…');
    expect(regenBtn.disabled).toBe(true);
  });

  it('renders data-trigger entity chips + cadence', async () => {
    const el = await mount(
      makeProps({
        loadData: vi.fn().mockResolvedValue(
          makeData({
            kindEyebrow: 'Data trigger',
            heroIcon: 'Clock',
            cronExprs: [],
            nextRuns: [],
            dataDetail: {
              entities: ['core.content_derivative', 'core.event'],
              everyLabel: 'Every 5m',
            },
          }),
        ),
      }),
    );
    expect(el.textContent).toContain('core.content_derivative');
    expect(el.textContent).toContain('core.event');
    expect(el.textContent).toContain('Every 5m');
  });

  it('renders the condition entity + readable where clause', async () => {
    const el = await mount(
      makeProps({
        loadData: vi.fn().mockResolvedValue(
          makeData({
            kindEyebrow: 'Condition',
            heroIcon: 'Clock',
            cronExprs: [],
            nextRuns: [],
            conditionDetail: {
              entity: 'core.event',
              whereText: '{\n  "status": "overdue"\n}',
              everyLabel: null,
            },
          }),
        ),
      }),
    );
    expect(el.textContent).toContain('core.event');
    expect(el.textContent).toContain('Checks');
    expect(el.querySelector('pre')?.textContent).toBe('{\n  "status": "overdue"\n}');
  });
});
