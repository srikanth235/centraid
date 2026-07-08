import type { JSX, ReactNode } from 'react';
import { Icon } from '@centraid/desktop-ui';
import type { InsightsBridgeProps } from '../bridge.js';
import { insK, insKindLabel, insUsd, relativeTime } from '../format.js';

// Daily-consumption line chart — a React port of `insLineChart`
// (app-insights.ts): same 760×200 viewBox, area gradient, peak marker.
function LineChart({ values }: { values: readonly number[] }): JSX.Element {
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
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const peakIdx = values.indexOf(max);
  const peak = pts[peakIdx] ?? ([0, 0] as const);
  return (
    <div className="cd-ins-chart-plot">
      <div className="cd-ins-chart-svg-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="cd-ins-chart-svg">
          <defs>
            <linearGradient id="insArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#insArea)" />
          <path
            d={line}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={peak[0].toFixed(1)}
            cy={peak[1].toFixed(1)}
            r={4}
            fill="var(--bg-elev)"
            stroke="var(--accent)"
            strokeWidth={2}
          />
        </svg>
      </div>
      <div className="cd-ins-chart-peak" style={{ left: `${((peak[0] / W) * 100).toFixed(2)}%` }}>
        {insK(max)}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  foot,
}: {
  icon: JSX.Element;
  label: string;
  value: string;
  foot?: ReactNode;
}): JSX.Element {
  return (
    <div className="cd-ins-kpi">
      <div className="cd-ins-kpi-label">
        <span className="cd-ins-kpi-icon">{icon}</span>
        {label}
      </div>
      <div className="cd-ins-kpi-value">{value}</div>
      {foot ? <div className="cd-ins-kpi-foot">{foot}</div> : null}
    </div>
  );
}

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="cd-ins-panel">
      <header className="cd-ins-panel-head">
        <h2>{title}</h2>
        {meta ? <span className="cd-ins-panel-meta">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

function ChartStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}): JSX.Element {
  return (
    <div className="cd-ins-chart-stat">
      <div className="cd-ins-chart-stat-label">{label}</div>
      <div className="cd-ins-chart-stat-value">{value}</div>
      {sub ? <div className="cd-ins-chart-stat-sub">{sub}</div> : null}
    </div>
  );
}

function EmptyLine({ message }: { message: string }): JSX.Element {
  return (
    <div className="cd-page-empty">
      <div className="cd-page-empty-icon" aria-hidden="true">
        <Icon name="Sparkle" size={22} />
      </div>
      <div className="cd-page-empty-text">{message}</div>
    </div>
  );
}

/**
 * Insights — the usage-analytics dashboard, ported to React (issue #325,
 * Phase 3). Read-only: the vanilla route module fetches the summary and mounts
 * this with the resolved data via `window.CentraidReact.mountInsights`.
 * Reproduces the vanilla `cd-ins-*` markup so the global styles.css renders it
 * identically.
 */
export default function InsightsScreen({ summary }: InsightsBridgeProps): JSX.Element {
  const { kpis } = summary;
  const quotaPct =
    kpis.quotaTokens > 0
      ? Math.min(100, Math.round((kpis.totalTokens / kpis.quotaTokens) * 100))
      : 0;

  const series = summary.daily.map((d) => d.tokens);
  const hasDaily = series.length > 0;
  const dailyTotal = series.reduce((s, v) => s + v, 0);
  const avg = hasDaily ? Math.round(dailyTotal / series.length) : 0;
  const peak = hasDaily ? Math.max(...series) : 0;
  const peakDay = hasDaily ? summary.daily[series.indexOf(peak)]?.date : undefined;
  const sorted = [...series].sort((a, b) => a - b);
  const median = hasDaily ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0;

  const autoMax = Math.max(1, ...summary.byAutomation.map((r) => r.tokens));
  const modelTotal = Math.max(
    1,
    summary.byModel.reduce((s, m) => s + m.tokens, 0),
  );

  return (
    <div className="cd-ins-page">
      <div className="cd-ins-head">
        <div className="cd-ins-title">
          <span className="cd-ins-title-icon">
            <Icon name="Activity" size={18} strokeWidth={2} />
          </span>
          <h1>Insights</h1>
        </div>
        <div className="cd-ins-filters">
          <span className="cd-ins-filter cd-ins-filter-static">
            <span className="cd-ins-filter-icon">
              <Icon name="History" size={13} />
            </span>
            <span>Last 30 days</span>
          </span>
        </div>
      </div>

      <div className="cd-ins-body">
        <div className="cd-ins-kpis">
          <StatCard
            icon={<Icon name="Activity" size={12} />}
            label="Tokens · 30 days"
            value={insK(kpis.totalTokens)}
            foot={
              <div className="cd-ins-meter">
                <div className="cd-ins-bar">
                  <div className="cd-ins-bar-fill" style={{ width: `${quotaPct}%` }} />
                </div>
                <div className="cd-ins-meter-foot">
                  <span>{`${insK(kpis.totalTokens)} of ${insK(kpis.quotaTokens)} included`}</span>
                  <span>{`${quotaPct}%`}</span>
                </div>
              </div>
            }
          />
          <StatCard
            icon={<Icon name="Coin" size={12} />}
            label="Spent · USD"
            value={insUsd(kpis.totalCostUsd)}
            foot={<span className="cd-ins-kpi-sub">last 30 days</span>}
          />
          <StatCard
            icon={<Icon name="History" size={12} />}
            label="Forecast · USD"
            value={insUsd(kpis.forecastCostUsd)}
            foot={<span className="cd-ins-kpi-sub">30-day run rate</span>}
          />
          <StatCard
            icon={<Icon name="Folder" size={12} />}
            label="Apps touched"
            value={String(kpis.appsTouched)}
            foot={<span className="cd-ins-kpi-sub">last 30 days</span>}
          />
          <StatCard
            icon={<Icon name="Sparkle" size={12} />}
            label="Generations"
            value={String(kpis.generations)}
            foot={<span className="cd-ins-kpi-sub">{`${kpis.retries} retries`}</span>}
          />
        </div>

        <div className="cd-ins-grid">
          <div className="cd-ins-col">
            <Panel title="Daily consumption" meta={`${summary.windowDays} days · tokens`}>
              {hasDaily ? (
                <div className="cd-ins-chart">
                  <div className="cd-ins-chart-stats">
                    <ChartStat label="Daily avg" value={insK(avg)} />
                    <ChartStat label="Peak" value={insK(peak)} sub={peakDay} />
                    <ChartStat label="Median" value={insK(median)} />
                    <ChartStat label="Days" value={String(series.length)} />
                  </div>
                  <LineChart
                    values={series.length === 1 ? [series[0] ?? 0, series[0] ?? 0] : series}
                  />
                  <div className="cd-ins-chart-axis">
                    <span>{summary.daily[0]?.date}</span>
                    <span>{summary.daily[summary.daily.length - 1]?.date}</span>
                  </div>
                </div>
              ) : (
                <EmptyLine message="No activity in this window yet." />
              )}
            </Panel>

            <Panel title="By source" meta={`${summary.byAutomation.length} · sorted by tokens`}>
              <div className="cd-ins-table">
                <div className="cd-ins-tr cd-ins-tr-head">
                  <span className="cd-ins-th cd-ins-c-app">Source</span>
                  <span className="cd-ins-th cd-ins-c-num">Tokens</span>
                  <span className="cd-ins-th cd-ins-c-num">USD</span>
                  <span className="cd-ins-th cd-ins-c-mix">Mix</span>
                  <span className="cd-ins-th cd-ins-c-runs">Runs</span>
                </div>
                {summary.byAutomation.map((r) => (
                  <div key={r.key} className="cd-ins-tr">
                    <span className="cd-ins-td cd-ins-c-app">
                      <span className="cd-ins-tag">{insKindLabel(r.kind)}</span>
                      <span className="cd-ins-app-name">{r.label}</span>
                    </span>
                    <span className="cd-ins-td cd-ins-c-num cd-ins-mono">{insK(r.tokens)}</span>
                    <span className="cd-ins-td cd-ins-c-num cd-ins-mono">{insUsd(r.costUsd)}</span>
                    <span className="cd-ins-td cd-ins-c-mix">
                      <span className="cd-ins-mixbar">
                        <span
                          className="cd-ins-mixbar-fill"
                          style={{ width: `${Math.round((r.tokens / autoMax) * 100)}%` }}
                        />
                      </span>
                    </span>
                    <span className="cd-ins-td cd-ins-c-runs cd-ins-mono">{String(r.runs)}</span>
                  </div>
                ))}
                {summary.byAutomation.length === 0 ? (
                  <div className="cd-ins-tr">
                    <EmptyLine message="No runs yet." />
                  </div>
                ) : null}
              </div>
            </Panel>
          </div>

          <div className="cd-ins-col">
            <Panel title="By model" meta="last 30 days">
              <div className="cd-ins-models">
                {summary.byModel.map((m) => {
                  const pct = Math.round((m.tokens / modelTotal) * 100);
                  return (
                    <div key={m.model} className="cd-ins-model">
                      <div className="cd-ins-model-name">{m.model}</div>
                      <div className="cd-ins-bar">
                        <div className="cd-ins-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="cd-ins-model-foot">
                        <span className="cd-ins-mono">{`${pct}%  ${insK(m.tokens)}`}</span>
                        <span className="cd-ins-mono">{insUsd(m.costUsd)}</span>
                      </div>
                    </div>
                  );
                })}
                {summary.byModel.length === 0 ? (
                  <EmptyLine message="No model usage recorded yet." />
                ) : null}
              </div>
            </Panel>

            <Panel title="Recent activity" meta={`${summary.kpis.generations} generations`}>
              <div className="cd-ins-activity">
                {summary.recent.map((a) => (
                  <div key={a.runId} className="cd-ins-act">
                    <span className="cd-ins-act-ago cd-ins-mono">
                      {relativeTime(new Date(a.startedAt).toISOString())}
                    </span>
                    <div className="cd-ins-act-body">
                      <div className="cd-ins-act-app">
                        <span className="cd-ins-tag">{insKindLabel(a.kind)}</span>
                        <span>{a.ok ? '' : ' · failed'}</span>
                      </div>
                      <div className="cd-ins-act-note">{a.label}</div>
                    </div>
                    <div className="cd-ins-act-cost">
                      <span className="cd-ins-mono">{insK(a.tokens)}</span>
                      <span className="cd-ins-mono cd-ins-act-usd">{insUsd(a.costUsd)}</span>
                    </div>
                  </div>
                ))}
                {summary.recent.length === 0 ? <EmptyLine message="No activity yet." /> : null}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
