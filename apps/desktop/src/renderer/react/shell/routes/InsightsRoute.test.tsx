import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getInsightsSummary = vi.fn();
vi.mock('../../../gateway-client.js', () => ({
  getInsightsSummary: () => getInsightsSummary(),
}));

let InsightsRoute: typeof import('./InsightsRoute.js').default;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  ({ default: InsightsRoute } = await import('./InsightsRoute.js'));
  getInsightsSummary.mockReset();
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
    forecastCostUsd: 5.1,
    generations: 42,
    retries: 3,
    appsTouched: 7,
    quotaTokens: 256_000,
  },
  daily: [{ date: '2026-06-08', tokens: 1000, costUsd: 0.1, runs: 2 }],
  byAutomation: [],
  byModel: [],
  recent: [],
} as unknown as Awaited<ReturnType<typeof getInsightsSummary>>;

describe('InsightsRoute', () => {
  it('shows a loading line, then the dashboard once the summary resolves', async () => {
    let resolve!: (v: unknown) => void;
    getInsightsSummary.mockReturnValue(new Promise((r) => (resolve = r)));
    const el = await render();
    expect(el.textContent).toContain('Loading insights…');
    await act(async () => {
      resolve(summary);
    });
    expect(el.querySelector('.cd-au-loading')).toBeNull();
    expect(el.querySelector('.cd-main-scroll')).not.toBeNull();
  });

  it('renders an error line when the fetch rejects', async () => {
    getInsightsSummary.mockRejectedValue(new Error('offline'));
    const el = await render();
    expect(el.querySelector('.cd-page-empty')?.textContent).toContain('offline');
  });
});
