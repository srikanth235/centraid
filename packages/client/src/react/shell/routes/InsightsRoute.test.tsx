import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getInsightsSummary = vi.fn();
const listAutomations = vi.fn();
const navigate = vi.fn();
vi.mock('../../../gateway-client.js', () => ({
  getInsightsSummary: (input?: { windowDays?: number }) => getInsightsSummary(input),
  listAutomations: () => listAutomations(),
}));
vi.mock('../actions.js', () => ({
  useShellActions: () => ({ navigate }),
}));

let InsightsRoute: typeof import('./InsightsRoute.js').default;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  ({ default: InsightsRoute } = await import('./InsightsRoute.js'));
  getInsightsSummary.mockReset();
  listAutomations.mockReset();
  navigate.mockReset();
  listAutomations.mockResolvedValue([]);
});

async function render(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<InsightsRoute />);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const summary = {
  windowDays: 30,
  generatedAt: 0,
  kpis: {
    totalTokens: 128_000,
    totalCostUsd: 3.4,
    agentReportedCostUsd: 2.0,
    estimatedCostUsd: 1.4,
    forecastCostUsd: 5.1,
    generations: 42,
    retries: 3,
    failedRuns: 0,
    failedCostUsd: 0,
    appsTouched: 7,
    unpricedRuns: 0,
    unreportedRuns: 0,
  },
  daily: [{ date: '2026-06-08', tokens: 1000, costUsd: 0.1, runs: 2 }],
  bySource: [] as Array<{
    key: string;
    label: string;
    kind: string;
    runs: number;
    tokens: number;
    costUsd: number;
    automationName?: string;
  }>,
  byRunner: [],
  byModel: [],
  recent: [] as Array<{
    runId: string;
    kind: string;
    label: string;
    automationRef?: string;
    automationName?: string;
    ok: boolean;
    startedAt: number;
    tokens: number;
    costUsd: number;
  }>,
};

describe('InsightsRoute', () => {
  it('shows a loading line, then the dashboard once the summary resolves', async () => {
    let resolveSummary!: (v: unknown) => void;
    getInsightsSummary.mockReturnValue(new Promise((resolve) => (resolveSummary = resolve)));
    const el = await render();
    expect(el.textContent).toContain('Loading insights…');
    await act(async () => {
      resolveSummary(summary);
    });
    expect(el.querySelector('.cd-au-loading')).toBeNull();
    expect(el.querySelector('.mainScroll')).not.toBeNull();
    expect(el.textContent).toContain('$3.40');
  });

  it('renders an error line when the fetch rejects', async () => {
    getInsightsSummary.mockRejectedValue(new Error('offline'));
    const el = await render();
    expect(el.querySelector('.pageEmpty')?.textContent).toContain('offline');
  });

  it('resolves automation display names for by-source + recent rows', async () => {
    listAutomations.mockResolvedValue([
      { ref: 'system-health-check/system-health-check', name: 'System health check' },
    ]);
    getInsightsSummary.mockResolvedValue({
      ...summary,
      bySource: [
        {
          key: 'system-health-check/system-health-check',
          label: 'Automation',
          kind: 'automation',
          runs: 1,
          tokens: 0,
          costUsd: 0,
        },
      ],
      recent: [
        {
          runId: 'r1',
          kind: 'automation',
          label: 'ok',
          automationRef: 'system-health-check/system-health-check',
          ok: true,
          startedAt: 1750000000000,
          tokens: 0,
          costUsd: 0,
        },
      ],
    });
    const el = await render();
    const hits = el.textContent?.match(/System health check/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to the run-recorded automation name for a deleted automation', async () => {
    listAutomations.mockResolvedValue([]);
    getInsightsSummary.mockResolvedValue({
      ...summary,
      bySource: [
        {
          key: 'gone-app/gone-auto',
          label: 'Automation',
          kind: 'automation',
          runs: 1,
          tokens: 0,
          costUsd: 0,
          automationName: 'Gone Automation',
        },
      ],
      recent: [
        {
          runId: 'r1',
          kind: 'automation',
          label: 'ok',
          automationRef: 'gone-app/gone-auto',
          automationName: 'Gone Automation',
          ok: true,
          startedAt: 1750000000000,
          tokens: 0,
          costUsd: 0,
        },
      ],
    });
    const el = await render();
    const hits = el.textContent?.match(/Gone Automation/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(el.textContent).not.toContain('gone-app/gone-auto');
  });

  it('requests the default 30-day window', async () => {
    getInsightsSummary.mockResolvedValue(summary);
    await render();
    expect(getInsightsSummary).toHaveBeenCalledWith({ windowDays: 30 });
  });
});
