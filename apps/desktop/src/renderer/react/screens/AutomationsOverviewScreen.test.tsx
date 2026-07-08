import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuOverviewData, AutomationsOverviewBridgeProps } from '../bridge.js';
import AutomationsOverviewScreen from './AutomationsOverviewScreen.js';

function makeData(over: Partial<AuOverviewData> = {}): AuOverviewData {
  return {
    subtitle: '1 active  ·  1 paused  ·  2 recent runs',
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
        statusKind: 'active',
        statusLabel: 'Active',
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
        metaLabel: 'cron · 3s · 1.2k',
      },
      {
        runId: 'r2',
        automationId: 'a',
        ok: false,
        name: 'Daily Digest',
        summary: 'API error',
        whenLabel: '1d ago',
        metaLabel: 'cron · 1s · 0.3k',
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
  it('renders health tiles, the automation row, and recent runs', async () => {
    const el = await mount(makeProps());
    expect(el.querySelectorAll('.cd-au-health-tile').length).toBe(4);
    expect(el.textContent).toContain('Daily Digest');
    expect(el.textContent).toContain('Every day at 8am');
    expect(el.textContent).toContain('Last run 2h ago');
    expect((el.querySelector('.cd-au-status') as HTMLElement | null)?.dataset.tone).toBe('active');
    expect(el.querySelectorAll('.cd-au-ov-run').length).toBe(2);
    expect(el.textContent).toContain('Summarized 12 emails');
  });

  it('opens an automation and a run via callbacks', async () => {
    const props = makeProps();
    const el = await mount(props);
    await act(async () =>
      (el.querySelector('.cd-au-ov-row') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onOpenAutomation).toHaveBeenCalledWith('a@1');
    await act(async () =>
      (el.querySelector('.cd-au-ov-run') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onOpenRun).toHaveBeenCalledWith('a', 'r1');
  });

  it('fires the header actions', async () => {
    const props = makeProps();
    const el = await mount(props);
    const [browse, create] = [
      ...el.querySelectorAll('.cd-au-actions .cd-au-btn'),
    ] as HTMLButtonElement[];
    await act(async () => browse?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => create?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onBrowseTemplates).toHaveBeenCalledTimes(1);
    expect(props.onNewAutomation).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when there are no automations', async () => {
    const el = await mount(
      makeProps({
        loadData: vi.fn().mockResolvedValue(
          makeData({
            rows: [],
            runs: [],
            health: { active: 0, paused: 0, drafts: 0, attention: 0 },
          }),
        ),
      }),
    );
    expect(el.textContent).toContain('No automations yet');
    expect(el.querySelectorAll('.cd-au-health-tile').length).toBe(0);
  });

  it('renders the error state + retry when loadData rejects', async () => {
    const loadData = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeData());
    const el = await mount(makeProps({ loadData }));
    expect(el.textContent).toContain("Couldn't load automations");
    expect(el.textContent).toContain('boom');
    await act(async () =>
      (el.querySelector('.cd-au-btn-primary') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(loadData).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('Daily Digest');
  });
});
