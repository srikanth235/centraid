import type { JSX, ReactNode } from 'react';
import { Icon } from '../ui/index.js';
import type { InsightsBridgeProps } from '../screen-contracts.js';
import { insK, insKindLabel, insUsd, relativeTime } from '../format.js';
import styles from './InsightsScreen.module.css';
import { cx } from '../ui/cx.js';

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
    <div className={styles.chartPlot}>
      <div className={styles.chartSvgWrap}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.chartSvg}>
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
      <div className={styles.chartPeak} style={{ left: `${((peak[0] / W) * 100).toFixed(2)}%` }}>
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
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>
        <span className={styles.kpiIcon}>{icon}</span>
        {label}
      </div>
      <div className={styles.kpiValue}>{value}</div>
      {foot ? <div className={styles.kpiFoot}>{foot}</div> : null}
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
    <section className={styles.panel}>
      <header className={styles.panelHead}>
        <h2>{title}</h2>
        {meta ? <span className={styles.panelMeta}>{meta}</span> : null}
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
    <div>
      <div className={styles.chartStatLabel}>{label}</div>
      <div className={styles.chartStatValue}>{value}</div>
      {sub ? <div className={styles.chartStatSub}>{sub}</div> : null}
    </div>
  );
}

// A panel among several on an otherwise-populated page being empty isn't
// page-level news — no icon, no dashed frame (that treatment is reserved
// for the whole route being empty, e.g. ApprovalsScreen's inbox). A quiet
// single line matches this app's existing in-panel empty idiom (see
// ApprovalsScreen's `.grantsEmpty`).
// `compact` — for a panel that already carries its own structure above the
// message (the By-source table header), so it needs no reserved height. The
// non-compact form gives the bare right-column panels enough presence to land
// level with the taller left column.
function PanelEmpty({ message, compact }: { message: string; compact?: boolean }): JSX.Element {
  return <div className={compact ? styles.panelEmptyCompact : styles.panelEmpty}>{message}</div>;
}

// The daily-consumption panel reserves a chart-sized footprint so the layout
// doesn't jump when the first data lands. Filling that footprint with a lone
// centered sentence reads as dead space; a faint gridded baseline turns it
// into a legible "chart awaiting data" scaffold, and the note sits on a chip
// so a gridline never strikes through it.
function ChartEmpty({ message }: { message: string }): JSX.Element {
  return (
    <div className={styles.chartEmpty} aria-hidden={false}>
      <div className={styles.chartEmptyGrid} aria-hidden="true" />
      <span className={styles.chartEmptyNote}>{message}</span>
    </div>
  );
}

/**
 * Insights — the usage-analytics dashboard (issue #325). Read-only: its route
 * (InsightsRoute) fetches the summary and renders this with the resolved data.
 * Styles are co-located in `InsightsScreen.module.css` (scoped CSS Modules —
 * issue #325 Phase 4); the shared `cd-page-empty*` empty-state classes stay
 * global (also used by the vanilla shell + Discover).
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
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="Activity" size={18} strokeWidth={2} />
          </span>
          <h1>Insights</h1>
        </div>
        <div className={styles.filters}>
          <span className={styles.filter}>
            <span className={styles.filterIcon}>
              <Icon name="History" size={13} />
            </span>
            <span>Last 30 days</span>
          </span>
        </div>
      </div>

      <div>
        <div className={styles.kpis}>
          <StatCard
            icon={<Icon name="Activity" size={12} />}
            label="Tokens · 30 days"
            value={insK(kpis.totalTokens)}
            foot={
              <div className={styles.meter}>
                <div className={styles.bar}>
                  <div className={styles.barFill} style={{ width: `${quotaPct}%` }} />
                </div>
                <div className={styles.meterFoot}>
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
            foot={
              // Honest unknowns (#445): a NULL-cost run is unpriced, not free —
              // flag it near the cost so the total reads as a floor, not truth.
              <span className={styles.kpiSub}>
                {kpis.unpricedRuns > 0
                  ? `last 30 days · ${kpis.unpricedRuns} unpriced`
                  : 'last 30 days'}
              </span>
            }
          />
          <StatCard
            icon={<Icon name="History" size={12} />}
            label="Forecast · USD"
            value={insUsd(kpis.forecastCostUsd)}
            foot={<span className={styles.kpiSub}>30-day run rate</span>}
          />
          <StatCard
            icon={<Icon name="Folder" size={12} />}
            label="Apps touched"
            value={String(kpis.appsTouched)}
            foot={<span className={styles.kpiSub}>last 30 days</span>}
          />
          <StatCard
            icon={<Icon name="Sparkle" size={12} />}
            label="Generations"
            value={String(kpis.generations)}
            foot={<span className={styles.kpiSub}>{`${kpis.retries} retries`}</span>}
          />
        </div>

        <div className={styles.grid}>
          <div className={styles.col}>
            <Panel title="Daily consumption" meta={`${summary.windowDays} days · tokens`}>
              {hasDaily ? (
                <div className={styles.chart}>
                  <div className={styles.chartStats}>
                    <ChartStat label="Daily avg" value={insK(avg)} />
                    <ChartStat label="Peak" value={insK(peak)} sub={peakDay} />
                    <ChartStat label="Median" value={insK(median)} />
                    <ChartStat label="Days" value={String(series.length)} />
                  </div>
                  <LineChart
                    values={series.length === 1 ? [series[0] ?? 0, series[0] ?? 0] : series}
                  />
                  <div className={styles.chartAxis}>
                    <span>{summary.daily[0]?.date}</span>
                    <span>{summary.daily[summary.daily.length - 1]?.date}</span>
                  </div>
                </div>
              ) : (
                <ChartEmpty message="No activity in this window yet." />
              )}
            </Panel>

            <Panel title="By source" meta={`${summary.byAutomation.length} · sorted by tokens`}>
              <div className={styles.table}>
                <div className={cx(styles.tr, styles.trHead)}>
                  <span className={cx(styles.th, styles.cApp)}>Source</span>
                  <span className={cx(styles.th, styles.cNum)}>Tokens</span>
                  <span className={cx(styles.th, styles.cNum)}>USD</span>
                  <span className={styles.th}>Mix</span>
                  <span className={cx(styles.th, styles.cRuns)}>Runs</span>
                </div>
                {summary.byAutomation.map((r) => (
                  <div key={r.key} className={styles.tr}>
                    <span className={cx(styles.td, styles.cApp)}>
                      <span className={styles.tag}>{insKindLabel(r.kind)}</span>
                      <span className={styles.appName}>{r.label}</span>
                    </span>
                    <span className={cx(styles.td, styles.cNum, styles.mono)}>
                      {insK(r.tokens)}
                    </span>
                    <span className={cx(styles.td, styles.cNum, styles.mono)}>
                      {insUsd(r.costUsd)}
                    </span>
                    <span className={styles.td}>
                      <span className={styles.mixbar}>
                        <span
                          className={styles.mixbarFill}
                          style={{ width: `${Math.round((r.tokens / autoMax) * 100)}%` }}
                        />
                      </span>
                    </span>
                    <span className={cx(styles.td, styles.cRuns, styles.mono)}>
                      {String(r.runs)}
                    </span>
                  </div>
                ))}
                {summary.byAutomation.length === 0 ? (
                  <PanelEmpty compact message="No runs yet." />
                ) : null}
              </div>
            </Panel>
          </div>

          <div className={styles.col}>
            <Panel title="By model" meta="last 30 days">
              <div className={styles.models}>
                {summary.byModel.map((m) => {
                  const pct = Math.round((m.tokens / modelTotal) * 100);
                  return (
                    <div key={m.model} className={styles.model}>
                      <div className={styles.modelName}>{m.model}</div>
                      <div className={styles.bar}>
                        <div className={styles.barFill} style={{ width: `${pct}%` }} />
                      </div>
                      <div className={styles.modelFoot}>
                        <span className={styles.mono}>{`${pct}%  ${insK(m.tokens)}`}</span>
                        <span className={styles.mono}>{insUsd(m.costUsd)}</span>
                      </div>
                    </div>
                  );
                })}
                {summary.byModel.length === 0 ? (
                  <PanelEmpty message="No model usage recorded yet." />
                ) : null}
              </div>
            </Panel>

            <Panel title="Recent activity" meta={`${summary.kpis.generations} generations`}>
              <div className={styles.activity}>
                {summary.recent.map((a) => (
                  <div key={a.runId} className={styles.act}>
                    <span className={cx(styles.actAgo, styles.mono)}>
                      {relativeTime(new Date(a.startedAt).toISOString())}
                    </span>
                    <div className={styles.actBody}>
                      <div className={styles.actApp}>
                        <span className={styles.tag}>{insKindLabel(a.kind)}</span>
                        <span>{a.ok ? '' : ' · failed'}</span>
                      </div>
                      <div className={styles.actNote}>{a.label}</div>
                    </div>
                    <div className={styles.actCost}>
                      <span className={styles.mono}>{insK(a.tokens)}</span>
                      <span className={cx(styles.mono, styles.actUsd)}>{insUsd(a.costUsd)}</span>
                    </div>
                  </div>
                ))}
                {summary.recent.length === 0 ? <PanelEmpty message="No activity yet." /> : null}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
