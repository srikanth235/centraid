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
    agentReportedCostUsd: 2.1,
    estimatedCostUsd: 1.3,
    forecastCostUsd: 5.1,
    generations: 42,
    retries: 3,
    failedRuns: 2,
    failedCostUsd: 0.4,
    appsTouched: 7,
    unpricedRuns: 1,
    unreportedRuns: 0,
  },
  daily: [
    { date: '2026-06-08', tokens: 1000, costUsd: 0.1, runs: 2 },
    { date: '2026-06-09', tokens: 4000, costUsd: 0.4, runs: 5 },
    { date: '2026-06-10', tokens: 2000, costUsd: 0.2, runs: 3 },
  ],
  bySource: [
    { key: 'a1', label: 'Daily Digest', kind: 'automation', runs: 5, tokens: 8000, costUsd: 2 },
    { key: 'c1', label: 'Chat', kind: 'chat', runs: 2, tokens: 3000, costUsd: 0.3 },
  ],
  byRunner: [{ provider: 'claude-code', runs: 7, tokens: 11_000, costUsd: 2.5 }],
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
      provider: 'claude-code',
    },
    {
      runId: 'r2',
      kind: 'automation',
      label: 'A failed run',
      automationRef: 'app/x',
      ok: false,
      startedAt: 0,
      tokens: 200,
      costUsd: 0.02,
    },
  ],
  peakDay: {
    date: '2026-06-09',
    tokens: 4000,
    costUsd: 0.4,
    topSources: [
      { key: 'a1', label: 'Daily Digest', kind: 'automation', tokens: 3000, costUsd: 0.3 },
    ],
  },
  attention: {
    kind: 'top_source',
    key: 'a1',
    label: 'Daily Digest',
    kindLabel: 'Automation',
    share: 0.59,
    costUsd: 2,
  },
};

const empty: InsightsSummary = {
  ...summary,
  kpis: {
    ...summary.kpis,
    totalTokens: 0,
    totalCostUsd: 0,
    agentReportedCostUsd: 0,
    estimatedCostUsd: 0,
    generations: 0,
    unpricedRuns: 0,
    unreportedRuns: 0,
    failedRuns: 0,
    failedCostUsd: 0,
  },
  daily: [],
  bySource: [],
  byRunner: [],
  byModel: [],
  recent: [],
  peakDay: undefined,
  attention: undefined,
};

describe('InsightsScreen (#514)', () => {
  it('renders the hero spend narrative and honesty line', () => {
    const html = renderToStaticMarkup(
      <InsightsScreen summary={summary} windowDays={30} onWindowDays={() => undefined} />,
    );
    expect(html).toContain('<h1>Insights</h1>');
    expect(html).toContain('$3.40');
    expect(html).toContain('agent-reported');
    expect(html).toContain('estimated');
    expect(html).toContain('1 unpriced');
    expect(html).toContain('At least');
    expect(html).not.toContain('included');
  });

  it('renders window chips and attention callout', () => {
    const html = renderToStaticMarkup(
      <InsightsScreen summary={summary} windowDays={30} onWindowDays={() => undefined} />,
    );
    expect(html).toContain('7d');
    expect(html).toContain('30d');
    expect(html).toContain('90d');
    expect(html).toContain('Daily Digest');
    expect(html).toContain('% of spend');
  });

  it('renders by-source, by-agent, by-model, and needs-attention', () => {
    const html = renderToStaticMarkup(
      <InsightsScreen summary={summary} windowDays={30} onWindowDays={() => undefined} />,
    );
    expect(html).toContain('Where it went');
    expect(html).toContain('By agent');
    expect(html).toContain('claude-code');
    expect(html).toContain('By model');
    expect(html).toContain('claude-opus-4-8');
    expect(html).toContain('Needs attention');
    expect(html).toContain('failed');
  });

  it('shows first-use copy when empty', () => {
    const html = renderToStaticMarkup(
      <InsightsScreen summary={empty} windowDays={30} onWindowDays={() => undefined} />,
    );
    expect(html).toContain('Run a chat, build, or automation');
  });
});
