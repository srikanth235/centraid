import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuOverviewData, AutomationsOverviewBridgeProps } from '../screen-contracts.js';
import AutomationsOverviewScreen from './AutomationsOverviewScreen.js';

function makeData(over: Partial<AuOverviewData> = {}): AuOverviewData {
  return {
    subtitle: 'unused — the screen derives its own subtitle from rows',
    health: { active: 1, paused: 1, drafts: 0, attention: 1 },
    rows: [
      {
        ref: 'a@1',
        id: 'a',
        name: 'Daily Digest',
        hue: 'indigo',
        glyphIcon: 'Bolt',
        triggerIcon: 'Clock',
        triggerLabel: 'Every day at 8am',
        integrations: ['Gmail'],
        lastRunLabel: 'Last run 2h ago',
        lastRunOk: true,
        lastRunSummary: 'Emailed your morning digest',
        nextRunLabel: 'Tomorrow, 8:00 AM',
        attentionCount: 0,
        statusKind: 'active',
        statusLabel: 'Active',
      },
      {
        ref: 'b@1',
        id: 'b',
        name: 'Invoice Sync',
        hue: 'rose',
        glyphIcon: 'Webhook',
        triggerIcon: 'Webhook',
        triggerLabel: 'Webhook',
        integrations: [],
        lastRunLabel: 'Last run 1d ago',
        lastRunOk: false,
        lastRunSummary: 'Timed out reaching the billing API',
        nextRunLabel: null,
        attentionCount: 2,
        statusKind: 'paused',
        statusLabel: 'Paused',
      },
    ],
    runs: [
      {
        runId: 'r1',
        automationId: 'a',
        ok: true,
        name: 'Daily Digest',
        summary: 'Summarized 12 emails',
        whenLabel: '2h ago',
        metaLabel: 'Cron · 3s · 1.2k',
        startedAt: Date.now(),
      },
      {
        runId: 'r2',
        automationId: 'b',
        ok: false,
        name: 'Invoice Sync',
        summary: 'API error',
        whenLabel: '1d ago',
        metaLabel: 'Webhook · 1s · 0.3k',
        startedAt: Date.now() - 86_400_000,
      },
    ],
    ...over,
  };
}

function makeProps(
  over: Partial<AutomationsOverviewBridgeProps> = {},
): AutomationsOverviewBridgeProps {
  return {
    loadData: vi.fn().mockResolvedValue(makeData()),
    onOpenAutomation: vi.fn(),
    onOpenRun: vi.fn(),
    onBrowseTemplates: vi.fn(),
    onNewAutomation: vi.fn(),
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
async function mount(props: AutomationsOverviewBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationsOverviewScreen {...props} />);
  });
  return container;
}

describe('AutomationsOverviewScreen', () => {
  it('renders the header, live-count subtitle, and both automation tiles', async () => {
    const el = await mount(makeProps());
    const heading = el.querySelector('h1');
    expect(heading?.textContent).toBe('Automations');
    // 1 active, 1 paused, and the paused row both fails its last run and
    // carries pending consent items → 1 automation needs attention.
    expect(el.textContent).toContain('1 active');
    expect(el.textContent).toContain('1 paused');
    expect(el.textContent).toContain('1 needs attention');
    expect(el.textContent).toContain('Your automations');
    expect(el.textContent).toContain('Daily Digest');
    expect(el.textContent).toContain('Invoice Sync');
    expect(el.textContent).toContain('Every day at 8am');
    // The tile shows the most-recent-run blurb (its summary) as the card body.
    expect(el.textContent).toContain('Emailed your morning digest');
    expect(el.textContent).toContain('Timed out reaching the billing API');
    // Attention / failed first: Invoice Sync before Daily Digest.
    const names = [...el.querySelectorAll('[data-testid="automation-row-name"]')].map(
      (n) => n.textContent,
    );
    expect(names[0]).toBe('Invoice Sync');
    expect(names[1]).toBe('Daily Digest');
    // Tiles live in the same grid container Home uses.
    const grid = el.querySelector('[data-testid="apps-grid"]');
    expect(grid).toBeTruthy();
    expect(grid?.querySelectorAll('[data-testid="automation-row"]').length).toBe(2);
  });

  it('exposes data-au-status on each tile and the attention badge only when pending', async () => {
    const el = await mount(makeProps());
    const statuses = [...el.querySelectorAll('[data-au-status]')].map(
      (n) => (n as HTMLElement).dataset.auStatus,
    );
    expect(statuses).toContain('active');
    expect(statuses).toContain('paused');
    // Only "Invoice Sync" (attentionCount: 2) shows the amber badge.
    expect(el.querySelectorAll('.attentionBadge').length).toBe(1);
    const rows = [...el.querySelectorAll('[data-testid="automation-row"]')];
    expect(rows).toHaveLength(2);
    const invoiceRow = rows.find((r) => r.textContent?.includes('Invoice Sync'));
    expect(invoiceRow?.textContent).toContain('2');
    // The failed/attention tile carries the restrained danger accent hook.
    expect((invoiceRow as HTMLElement).dataset.attention).toBe('true');
    const digestRow = rows.find((r) => r.textContent?.includes('Daily Digest'));
    expect(digestRow?.querySelector('.attentionBadge')).toBeNull();
    expect((digestRow as HTMLElement).dataset.attention).toBeUndefined();
  });

  it('renders the recent-activity feed grouped by date', async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain('Recent activity');
    expect(el.querySelectorAll('.activityRow').length).toBe(2);
    // The activity row shows the origin label, not the run summary text.
    expect(el.textContent).not.toContain('Summarized 12 emails');
    expect(el.textContent).toContain('Cron');
  });

  it('opens an automation and a run via callbacks', async () => {
    const props = makeProps();
    const el = await mount(props);
    // Sorted attention-first: Invoice Sync (b@1) is the first tile.
    await act(async () =>
      (el.querySelector('[data-testid="automation-row"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onOpenAutomation).toHaveBeenCalledWith('b@1');
    await act(async () =>
      (el.querySelector('.activityRow') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onOpenRun).toHaveBeenCalledWith('a', 'r1');
  });

  it('fires the header actions', async () => {
    const props = makeProps();
    const el = await mount(props);
    const browse = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Browse templates',
    );
    const create = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'New automation',
    );
    await act(async () => browse?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => create?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onBrowseTemplates).toHaveBeenCalledTimes(1);
    expect(props.onNewAutomation).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state with both CTAs when there are no automations', async () => {
    const el = await mount(
      makeProps({
        loadData: vi.fn().mockResolvedValue(makeData({ rows: [], runs: [] })),
      }),
    );
    expect(el.textContent).toContain('No automations yet');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'New automation')).toBe(
      true,
    );
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent === 'Browse templates'),
    ).toBe(true);
  });

  it('renders suggested starters on the empty state and adopts via onUseSuggestion', async () => {
    const onUseSuggestion = vi.fn();
    const el = await mount(
      makeProps({
        loadData: vi.fn().mockResolvedValue(makeData({ rows: [], runs: [] })),
        loadSuggestions: vi.fn().mockResolvedValue([
          {
            id: 'obligation-extractor',
            name: 'Document deadlines',
            desc: 'Pull due dates from docs',
            triggerLabel: 'When a document lands',
          },
          {
            id: 'google-gmail-pull',
            name: 'Gmail sync',
            desc: 'Pull mail into the vault',
          },
        ]),
        onUseSuggestion,
      }),
    );
    // suggestions load in a second effect — flush microtasks
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="automation-suggestions"]')).toBeTruthy();
    expect(el.textContent).toContain('Suggested');
    expect(el.textContent).toContain('Document deadlines');
    expect(el.textContent).toContain('Gmail sync');
    const addBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Add');
    await act(async () => addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onUseSuggestion).toHaveBeenCalledWith('obligation-extractor');
  });

  it('renders the error state + retry when loadData rejects', async () => {
    const loadData = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeData());
    const el = await mount(makeProps({ loadData }));
    expect(el.textContent).toContain("Couldn't load automations");
    expect(el.textContent).toContain('boom');
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    await act(async () => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(loadData).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('Daily Digest');
  });

  it('does not re-fetch when the parent swaps loadData identity (stable Retry card)', async () => {
    // Routes historically pass an inline async loadData each render. Remounting
    // the load effect on every identity change thrash-detached the Retry button
    // under Playwright (desktop e2e 8.2). loadData is read via a ref so only
    // mount + explicit Retry re-call it.
    const first = vi.fn().mockRejectedValue(new Error('gateway 500'));
    const second = vi.fn().mockRejectedValue(new Error('still 500'));
    const el = await mount(makeProps({ loadData: first }));
    expect(el.textContent).toContain("Couldn't load automations");
    expect(first).toHaveBeenCalledTimes(1);

    await act(async () => {
      root!.render(<AutomationsOverviewScreen {...makeProps({ loadData: second })} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still the error card — no second automatic load from identity churn.
    expect(el.textContent).toContain("Couldn't load automations");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(0);
    // Retry must invoke the *current* loadData (second), not a stale first.
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    second.mockResolvedValueOnce(makeData());
    await act(async () => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(second).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Daily Digest');
  });
});
