import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InsightsSummary } from '../screen-contracts.js';
import InsightsScreen from './InsightsScreen.js';

const summary: InsightsSummary = {
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
    unpricedRuns: 0,
  },
  daily: [
    { date: '2026-06-08', tokens: 1000, costUsd: 0.1, runs: 2 },
    { date: '2026-06-09', tokens: 4000, costUsd: 0.4, runs: 5 },
    { date: '2026-06-10', tokens: 2000, costUsd: 0.2, runs: 3 },
  ],
  byAutomation: [
    { key: 'a1', label: 'Daily Digest', kind: 'automation', runs: 5, tokens: 8000, costUsd: 0.8 },
    { key: 'c1', label: 'Builder', kind: 'build', runs: 2, tokens: 3000, costUsd: 0.3 },
  ],
  byModel: [{ model: 'claude-opus-4-8', runs: 7, tokens: 11_000, costUsd: 1.1 }],
  recent: [
    {
      runId: 'r1',
      kind: 'chat',
      label: 'A chat run',
      ok: true,
      startedAt: 0,
      tokens: 500,
      costUsd: 0.05,
    },
    {
      runId: 'r2',
      kind: 'automation',
      label: 'A failed run',
      ok: false,
      startedAt: 0,
      tokens: 200,
      costUsd: 0.02,
    },
  ],
};

const empty: InsightsSummary = {
  ...summary,
  daily: [],
  byAutomation: [],
  byModel: [],
  recent: [],
};

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('InsightsScreen', () => {
  it('renders the header and the five KPI cards', () => {
    const html = renderToStaticMarkup(<InsightsScreen summary={summary} />);
    expect(html).toContain('<h1>Insights</h1>');
    expect(html).toContain('Last 30 days');
    expect(count(html, 'kpi"')).toBe(5);
    expect(html).toContain('128k'); // insK(128_000)
    expect(html).toContain('$3.40'); // insUsd
  });

  it('draws the daily line chart with computed stats', () => {
    const html = renderToStaticMarkup(<InsightsScreen summary={summary} />);
    expect(html).toContain('chartSvg');
    expect(html).toContain('Daily avg');
    expect(html).toContain('Peak');
    // peak day label present
    expect(html).toContain('2026-06-09');
  });

  it('renders the by-source table rows and by-model bars', () => {
    const html = renderToStaticMarkup(<InsightsScreen summary={summary} />);
    expect(html).toContain('Daily Digest');
    expect(html).toContain('Builder');
    expect(html).toContain('claude-opus-4-8');
    // kind labels mapped
    expect(html).toContain('>Automation<');
    expect(html).toContain('>Build<');
  });

  it('shows empty states across panels when there is no data', () => {
    const html = renderToStaticMarkup(<InsightsScreen summary={empty} />);
    expect(html).toContain('No activity in this window yet.');
    expect(html).toContain('No runs yet.');
    expect(html).toContain('No model usage recorded yet.');
    expect(html).toContain('No activity yet.');
  });
});
