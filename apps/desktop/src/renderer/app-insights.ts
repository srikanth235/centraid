// Insights route — usage analytics dashboard bound to the unified run ledger
// via the `getInsightsSummary` IPC (issue #90). Token consumption, spend, and
// per-source / per-model breakdowns over a trailing 30-day window.
//
// Extracted from app.ts. Self-contained: it reaches the shell only through the
// render primitives on ShellContext (el, clear, pageScroll, mountShellPage,
// recordRoute, renderSimpleEmpty) and imports its pure formatters directly.
import { getInsightsSummary } from './gateway-client.js';
import { insK, insKindLabel, insUsd, relativeTime } from './app-format.js';
import type { ShellContext } from './app-shell-context.js';

export interface InsightsModule {
  renderInsights(): void;
}

export function createInsightsModule(ctx: ShellContext): InsightsModule {
  const { el, clear, pageScroll, mountShellPage, recordRoute, registerCleanup, renderSimpleEmpty } =
    ctx;

  function insLineChart(values: readonly number[]): HTMLElement {
    const W = 760;
    const H = 200;
    const PAD = 14;
    const n = values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const px = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * W);
    const py = (v: number): number => H - PAD - ((v - min) / span) * (H - PAD * 2);
    const pts = values.map((v, i) => [px(i), py(v)] as const);
    const line = pts
      .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
      .join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    const peakIdx = values.indexOf(max);
    const [peakX, peakY] = pts[peakIdx]!;
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cd-ins-chart-svg">
      <defs><linearGradient id="insArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#insArea)"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${peakX.toFixed(1)}" cy="${peakY.toFixed(1)}" r="4"
        fill="var(--bg-elev)" stroke="var(--accent)" stroke-width="2"/>
    </svg>`;
    const chart = el('div', { class: 'cd-ins-chart-plot' }, [
      el('div', { class: 'cd-ins-chart-svg-wrap', trustedHtml: svg }),
      el(
        'div',
        {
          class: 'cd-ins-chart-peak',
          style: { left: `${((peakX / W) * 100).toFixed(2)}%` },
        },
        `${insK(max)}`,
      ),
    ]);
    return chart;
  }

  function insStatCard(opts: {
    icon: string;
    label: string;
    value: string;
    foot?: HTMLElement | string;
  }): HTMLElement {
    return el('div', { class: 'cd-ins-kpi' }, [
      el('div', { class: 'cd-ins-kpi-label' }, [
        el('span', { class: 'cd-ins-kpi-icon', trustedHtml: opts.icon }),
        opts.label,
      ]),
      el('div', { class: 'cd-ins-kpi-value' }, opts.value),
      opts.foot ? el('div', { class: 'cd-ins-kpi-foot' }, [opts.foot]) : false,
    ]);
  }

  function insPanel(title: string, meta: string, body: HTMLElement): HTMLElement {
    return el('section', { class: 'cd-ins-panel' }, [
      el('header', { class: 'cd-ins-panel-head' }, [
        el('h2', {}, title),
        meta ? el('span', { class: 'cd-ins-panel-meta' }, meta) : false,
      ]),
      body,
    ]);
  }

  // One labelled stat in the daily-consumption panel header strip.
  function insChartStat(label: string, value: string, sub?: string, accent?: boolean): HTMLElement {
    return el('div', { class: 'cd-ins-chart-stat' }, [
      el('div', { class: 'cd-ins-chart-stat-label' }, label),
      el(
        'div',
        {
          class: accent
            ? 'cd-ins-chart-stat-value cd-ins-chart-stat-accent'
            : 'cd-ins-chart-stat-value',
        },
        value,
      ),
      sub ? el('div', { class: 'cd-ins-chart-stat-sub' }, sub) : false,
    ]);
  }

  function renderInsights(): void {
    void renderInsightsAsync();
  }

  async function renderInsightsAsync(): Promise<void> {
    recordRoute({ kind: 'insights' });
    clear();
    const { main, scroll } = pageScroll('', '');
    // pageScroll seeds an empty cd-page-head; the Insights page owns its
    // own header treatment, so drop it.
    scroll.replaceChildren();

    // Phase 3 (#325): when the React bundle is loaded, fetch the summary here
    // (gateway I/O stays vanilla) and render the whole dashboard via the ported
    // InsightsScreen; the vanilla builder below is the fallback.
    const bridge = window.CentraidReact;
    if (bridge?.mountInsights) {
      const host = el('div');
      scroll.append(host);
      host.append(el('div', { class: 'cd-au-loading' }, 'Loading insights…'));
      mountShellPage('insights', main);
      let reactSummary: CentraidInsightsSummary;
      try {
        reactSummary = await getInsightsSummary();
      } catch (err) {
        if (!document.contains(host)) return;
        host.replaceChildren(
          renderSimpleEmpty(
            `Couldn’t load insights: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      if (!document.contains(host)) return;
      host.replaceChildren();
      registerCleanup(bridge.mountInsights(host, { summary: reactSummary }));
      return;
    }

    const page = el('div', { class: 'cd-ins-page' });
    scroll.append(page);

    // ── Header — title + window label ────────────────────────────────
    page.append(
      el('div', { class: 'cd-ins-head' }, [
        el('div', { class: 'cd-ins-title' }, [
          el('span', {
            class: 'cd-ins-title-icon',
            trustedHtml: Icon.Activity({ size: 18, strokeWidth: 2 }),
          }),
          el('h1', {}, 'Insights'),
        ]),
        el('div', { class: 'cd-ins-filters' }, [
          el('span', { class: 'cd-ins-filter cd-ins-filter-static' }, [
            el('span', { class: 'cd-ins-filter-icon', trustedHtml: Icon.History({ size: 13 }) }),
            el('span', {}, 'Last 30 days'),
          ]),
        ]),
      ]),
    );

    const bodyHost = el('div', { class: 'cd-ins-body' });
    page.append(bodyHost);
    bodyHost.append(el('div', { class: 'cd-au-loading' }, 'Loading insights…'));
    mountShellPage('insights', main);

    let summary: CentraidInsightsSummary;
    try {
      summary = await getInsightsSummary();
    } catch (err) {
      if (!document.contains(bodyHost)) return;
      bodyHost.replaceChildren(
        renderSimpleEmpty(
          `Couldn’t load insights: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    // The user may have navigated away while the IPC was in flight.
    if (!document.contains(bodyHost)) return;
    bodyHost.replaceChildren();

    const { kpis } = summary;

    // ── KPI row ──────────────────────────────────────────────────────
    const quotaPct =
      kpis.quotaTokens > 0
        ? Math.min(100, Math.round((kpis.totalTokens / kpis.quotaTokens) * 100))
        : 0;
    bodyHost.append(
      el('div', { class: 'cd-ins-kpis' }, [
        insStatCard({
          icon: Icon.Activity({ size: 12 }),
          label: 'Tokens · 30 days',
          value: insK(kpis.totalTokens),
          foot: el('div', { class: 'cd-ins-meter' }, [
            el('div', { class: 'cd-ins-bar' }, [
              el('div', { class: 'cd-ins-bar-fill', style: { width: `${quotaPct}%` } }),
            ]),
            el('div', { class: 'cd-ins-meter-foot' }, [
              el('span', {}, `${insK(kpis.totalTokens)} of ${insK(kpis.quotaTokens)} included`),
              el('span', {}, `${quotaPct}%`),
            ]),
          ]),
        }),
        insStatCard({
          icon: Icon.Coin({ size: 12 }),
          label: 'Spent · USD',
          value: insUsd(kpis.totalCostUsd),
          foot: el('span', { class: 'cd-ins-kpi-sub' }, 'last 30 days'),
        }),
        insStatCard({
          icon: Icon.History({ size: 12 }),
          label: 'Forecast · USD',
          value: insUsd(kpis.forecastCostUsd),
          foot: el('span', { class: 'cd-ins-kpi-sub' }, '30-day run rate'),
        }),
        insStatCard({
          icon: Icon.Folder({ size: 12 }),
          label: 'Apps touched',
          value: String(kpis.appsTouched),
          foot: el('span', { class: 'cd-ins-kpi-sub' }, 'last 30 days'),
        }),
        insStatCard({
          icon: Icon.Sparkle({ size: 12 }),
          label: 'Generations',
          value: String(kpis.generations),
          foot: el('span', { class: 'cd-ins-kpi-sub' }, `${kpis.retries} retries`),
        }),
      ]),
    );

    // ── Two-column grid ──────────────────────────────────────────────
    const grid = el('div', { class: 'cd-ins-grid' });
    bodyHost.append(grid);
    const colMain = el('div', { class: 'cd-ins-col' });
    const colSide = el('div', { class: 'cd-ins-col' });
    grid.append(colMain, colSide);

    // Daily consumption ------------------------------------------------
    if (summary.daily.length > 0) {
      const series = summary.daily.map((d) => d.tokens);
      const total = series.reduce((s, v) => s + v, 0);
      const avg = Math.round(total / series.length);
      const peak = Math.max(...series);
      const peakDay = summary.daily[series.indexOf(peak)]!.date;
      const sorted = [...series].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const chartBody = el('div', { class: 'cd-ins-chart' }, [
        el('div', { class: 'cd-ins-chart-stats' }, [
          insChartStat('Daily avg', insK(avg)),
          insChartStat('Peak', insK(peak), peakDay),
          insChartStat('Median', insK(median)),
          insChartStat('Days', String(series.length)),
        ]),
        insLineChart(series.length === 1 ? [series[0]!, series[0]!] : series),
        el('div', { class: 'cd-ins-chart-axis' }, [
          el('span', {}, summary.daily[0]!.date),
          el('span', {}, summary.daily[summary.daily.length - 1]!.date),
        ]),
      ]);
      colMain.append(
        insPanel('Daily consumption', `${summary.windowDays} days · tokens`, chartBody),
      );
    } else {
      colMain.append(
        insPanel(
          'Daily consumption',
          `${summary.windowDays} days · tokens`,
          renderSimpleEmpty('No activity in this window yet.'),
        ),
      );
    }

    // By automation ----------------------------------------------------
    const autoTable = el('div', { class: 'cd-ins-table' });
    autoTable.append(
      el('div', { class: 'cd-ins-tr cd-ins-tr-head' }, [
        el('span', { class: 'cd-ins-th cd-ins-c-app' }, 'Source'),
        el('span', { class: 'cd-ins-th cd-ins-c-num' }, 'Tokens'),
        el('span', { class: 'cd-ins-th cd-ins-c-num' }, 'USD'),
        el('span', { class: 'cd-ins-th cd-ins-c-mix' }, 'Mix'),
        el('span', { class: 'cd-ins-th cd-ins-c-runs' }, 'Runs'),
      ]),
    );
    const autoMax = Math.max(1, ...summary.byAutomation.map((r) => r.tokens));
    for (const r of summary.byAutomation) {
      autoTable.append(
        el('div', { class: 'cd-ins-tr' }, [
          el('span', { class: 'cd-ins-td cd-ins-c-app' }, [
            el('span', { class: 'cd-ins-tag' }, insKindLabel(r.kind)),
            el('span', { class: 'cd-ins-app-name' }, r.label),
          ]),
          el('span', { class: 'cd-ins-td cd-ins-c-num cd-ins-mono' }, insK(r.tokens)),
          el('span', { class: 'cd-ins-td cd-ins-c-num cd-ins-mono' }, insUsd(r.costUsd)),
          el('span', { class: 'cd-ins-td cd-ins-c-mix' }, [
            el('span', { class: 'cd-ins-mixbar' }, [
              el('span', {
                class: 'cd-ins-mixbar-fill',
                style: { width: `${Math.round((r.tokens / autoMax) * 100)}%` },
              }),
            ]),
          ]),
          el('span', { class: 'cd-ins-td cd-ins-c-runs cd-ins-mono' }, String(r.runs)),
        ]),
      );
    }
    if (summary.byAutomation.length === 0) {
      autoTable.append(el('div', { class: 'cd-ins-tr' }, [renderSimpleEmpty('No runs yet.')]));
    }
    colMain.append(
      insPanel('By source', `${summary.byAutomation.length} · sorted by tokens`, autoTable),
    );

    // By model ---------------------------------------------------------
    const modelTotal = Math.max(
      1,
      summary.byModel.reduce((s, m) => s + m.tokens, 0),
    );
    const modelBody = el('div', { class: 'cd-ins-models' });
    for (const m of summary.byModel) {
      const pct = Math.round((m.tokens / modelTotal) * 100);
      modelBody.append(
        el('div', { class: 'cd-ins-model' }, [
          el('div', { class: 'cd-ins-model-name' }, m.model),
          el('div', { class: 'cd-ins-bar' }, [
            el('div', { class: 'cd-ins-bar-fill', style: { width: `${pct}%` } }),
          ]),
          el('div', { class: 'cd-ins-model-foot' }, [
            el('span', { class: 'cd-ins-mono' }, `${pct}%  ${insK(m.tokens)}`),
            el('span', { class: 'cd-ins-mono' }, insUsd(m.costUsd)),
          ]),
        ]),
      );
    }
    if (summary.byModel.length === 0) {
      modelBody.append(renderSimpleEmpty('No model usage recorded yet.'));
    }
    colSide.append(insPanel('By model', 'last 30 days', modelBody));

    // Recent activity --------------------------------------------------
    const actBody = el('div', { class: 'cd-ins-activity' });
    for (const a of summary.recent) {
      actBody.append(
        el('div', { class: 'cd-ins-act' }, [
          el(
            'span',
            { class: 'cd-ins-act-ago cd-ins-mono' },
            relativeTime(new Date(a.startedAt).toISOString()),
          ),
          el('div', { class: 'cd-ins-act-body' }, [
            el('div', { class: 'cd-ins-act-app' }, [
              el('span', { class: 'cd-ins-tag' }, insKindLabel(a.kind)),
              el('span', {}, a.ok ? '' : ' · failed'),
            ]),
            el('div', { class: 'cd-ins-act-note' }, a.label),
          ]),
          el('div', { class: 'cd-ins-act-cost' }, [
            el('span', { class: 'cd-ins-mono' }, insK(a.tokens)),
            el('span', { class: 'cd-ins-mono cd-ins-act-usd' }, insUsd(a.costUsd)),
          ]),
        ]),
      );
    }
    if (summary.recent.length === 0) {
      actBody.append(renderSimpleEmpty('No activity yet.'));
    }
    colSide.append(insPanel('Recent activity', `${summary.kpis.generations} generations`, actBody));
  }

  return { renderInsights };
}
