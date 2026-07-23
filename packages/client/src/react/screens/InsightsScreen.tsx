import type { JSX, ReactNode } from 'react';
import { Icon } from '../ui/index.js';
import type { InsightsBridgeProps } from '../screen-contracts.js';
import { insK, insKindLabel, insUsd, relativeTime } from '../format.js';
import styles from './InsightsScreen.module.css';
import { cx } from '../ui/cx.js';
import ResourceReceiptPanel from './ResourceReceiptPanel.js';

const WINDOW_OPTIONS = [7, 30, 90] as const;

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

function PanelEmpty({ message, compact }: { message: string; compact?: boolean }): JSX.Element {
  return <div className={compact ? styles.panelEmptyCompact : styles.panelEmpty}>{message}</div>;
}

function ChartEmpty({ message }: { message: string }): JSX.Element {
  return (
    <div className={styles.chartEmpty} aria-hidden={false}>
      <div className={styles.chartEmptyGrid} aria-hidden="true" />
      <span className={styles.chartEmptyNote}>{message}</span>
    </div>
  );
}

function MixBar({ pct }: { pct: number }): JSX.Element {
  return (
    <span className={styles.mixbar}>
      <span
        className={styles.mixbarFill}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </span>
  );
}

/**
 * Insights v0 (#514) — transparency + control over agent usage.
 * Narrative hero (honest spend), breakdowns sorted by $, working window chips.
 */
export default function InsightsScreen({
  summary,
  windowDays,
  onWindowDays,
  onOpenRun,
  resourceUsage,
}: InsightsBridgeProps): JSX.Element {
  const { kpis } = summary;
  const incomplete = kpis.unpricedRuns > 0 || kpis.unreportedRuns > 0;
  const hasSpend = kpis.totalCostUsd > 0 || incomplete;

  const series = summary.daily.map((d) => d.tokens);
  const hasDaily = series.length > 0;
  const sourceMax = Math.max(1, ...summary.bySource.map((r) => r.costUsd || r.tokens));
  const runnerMax = Math.max(1, ...summary.byRunner.map((r) => r.costUsd || r.tokens));
  const modelTotal = Math.max(
    1,
    summary.byModel.reduce((s, m) => s + (m.costUsd || m.tokens), 0),
  );

  const honestyParts: string[] = [];
  if (kpis.agentReportedCostUsd > 0) {
    honestyParts.push(`${insUsd(kpis.agentReportedCostUsd)} agent-reported`);
  }
  if (kpis.estimatedCostUsd > 0) {
    honestyParts.push(`${insUsd(kpis.estimatedCostUsd)} estimated`);
  }
  if (kpis.unpricedRuns > 0) {
    honestyParts.push(`${kpis.unpricedRuns} unpriced`);
  }
  if (kpis.unreportedRuns > 0) {
    honestyParts.push(`${kpis.unreportedRuns} no usage reported`);
  }
  if (honestyParts.length === 0 && kpis.generations === 0) {
    honestyParts.push('no completed runs in this window');
  } else if (honestyParts.length === 0) {
    honestyParts.push('all priced runs included');
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="Activity" size={18} strokeWidth={2} />
          </span>
          <h1>Insights</h1>
        </div>
        <div className={styles.filters} role="group" aria-label="Time window">
          {WINDOW_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              className={cx(styles.filter, windowDays === d && styles.filterActive)}
              onClick={() => onWindowDays(d)}
              aria-pressed={windowDays === d}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className={styles.hero} data-testid="insights-hero">
        <div className={styles.heroSpend}>
          <div className={styles.heroLabel}>
            {incomplete ? 'At least' : 'Spend'} · {windowDays} days
          </div>
          <div className={styles.heroValue}>{insUsd(kpis.totalCostUsd)}</div>
          <div className={styles.heroHonesty}>{honestyParts.join(' · ')}</div>
        </div>
        <div className={styles.heroMeta}>
          <div className={styles.heroStat}>
            <span className={styles.heroStatLabel}>Tokens</span>
            <span className={styles.heroStatValue}>{insK(kpis.totalTokens)}</span>
          </div>
          <div className={styles.heroStat}>
            <span className={styles.heroStatLabel}>Runs</span>
            <span className={styles.heroStatValue}>{kpis.generations}</span>
            {kpis.retries > 0 ? (
              <span className={styles.heroStatSub}>{kpis.retries} retries</span>
            ) : null}
          </div>
          <div className={styles.heroStat}>
            <span className={styles.heroStatLabel}>Forecast</span>
            <span className={styles.heroStatValue}>{insUsd(kpis.forecastCostUsd)}</span>
            <span className={styles.heroStatSub}>30-day run rate</span>
          </div>
          {kpis.failedRuns > 0 ? (
            <div className={styles.heroStat}>
              <span className={styles.heroStatLabel}>Failed</span>
              <span className={styles.heroStatValue}>{kpis.failedRuns}</span>
              <span className={styles.heroStatSub}>{insUsd(kpis.failedCostUsd)} spent</span>
            </div>
          ) : null}
        </div>
      </div>

      {summary.attention ? (
        <div className={styles.attention} data-testid="insights-attention">
          <Icon name="Sparkle" size={14} />
          <span>
            <strong>{summary.attention.label}</strong> ({summary.attention.kindLabel}) is{' '}
            {Math.round(summary.attention.share * 100)}% of spend (
            {insUsd(summary.attention.costUsd)})
          </span>
        </div>
      ) : null}

      {!hasSpend && kpis.generations === 0 ? (
        <div className={styles.firstUse}>
          Run a chat, build, or automation — usage shows up here. Costs are agent-reported when the
          runner provides them, otherwise estimated from public rates.
        </div>
      ) : null}

      {kpis.generations > 0 && kpis.unreportedRuns === kpis.generations ? (
        <div className={styles.firstUse}>
          Agents ran, but none reported token usage yet. Cost may be incomplete.
        </div>
      ) : null}

      <div className={styles.grid}>
        <div className={styles.col}>
          <Panel title="Where it went" meta={`${summary.bySource.length} · sorted by $`}>
            <div className={styles.table}>
              <div className={cx(styles.tr, styles.trHead)}>
                <span className={cx(styles.th, styles.cApp)}>Source</span>
                <span className={cx(styles.th, styles.cNum)}>USD</span>
                <span className={cx(styles.th, styles.cNum)}>Tokens</span>
                <span className={styles.th}>Mix</span>
                <span className={cx(styles.th, styles.cRuns)}>Runs</span>
              </div>
              {summary.bySource.map((r) => (
                <div key={`${r.kind}:${r.key}`} className={styles.tr}>
                  <span className={cx(styles.td, styles.cApp)}>
                    <span className={styles.tag}>{insKindLabel(r.kind)}</span>
                    <span className={styles.appName}>{r.label}</span>
                  </span>
                  <span className={cx(styles.td, styles.cNum, styles.mono)}>
                    {insUsd(r.costUsd)}
                  </span>
                  <span className={cx(styles.td, styles.cNum, styles.mono)}>{insK(r.tokens)}</span>
                  <span className={styles.td}>
                    <MixBar pct={Math.round(((r.costUsd || r.tokens) / sourceMax) * 100)} />
                  </span>
                  <span className={cx(styles.td, styles.cRuns, styles.mono)}>{String(r.runs)}</span>
                </div>
              ))}
              {summary.bySource.length === 0 ? <PanelEmpty compact message="No runs yet." /> : null}
            </div>
          </Panel>

          <Panel title="Daily activity" meta={`${summary.windowDays} days · tokens`}>
            {hasDaily ? (
              <div className={styles.chart}>
                {summary.peakDay ? (
                  <div className={styles.peakNote}>
                    Peak {summary.peakDay.date}: {insUsd(summary.peakDay.costUsd)} ·{' '}
                    {insK(summary.peakDay.tokens)} tokens
                    {summary.peakDay.topSources[0]
                      ? ` · top: ${summary.peakDay.topSources[0].label}`
                      : ''}
                  </div>
                ) : null}
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
        </div>

        <div className={styles.col}>
          <Panel title="By agent" meta="runner · sorted by $">
            <div className={styles.models}>
              {summary.byRunner.map((r) => {
                const pct = Math.round(((r.costUsd || r.tokens) / runnerMax) * 100);
                return (
                  <div key={r.provider} className={styles.model}>
                    <div className={styles.modelName}>{r.provider}</div>
                    <div className={styles.bar}>
                      <div className={styles.barFill} style={{ width: `${pct}%` }} />
                    </div>
                    <div className={styles.modelFoot}>
                      <span className={styles.mono}>
                        {insUsd(r.costUsd)} · {insK(r.tokens)}
                      </span>
                      <span className={styles.mono}>{r.runs} runs</span>
                    </div>
                  </div>
                );
              })}
              {summary.byRunner.length === 0 ? (
                <PanelEmpty message="No agent usage recorded yet." />
              ) : null}
            </div>
          </Panel>

          <Panel title="By model" meta="last window">
            <div className={styles.models}>
              {summary.byModel.map((m) => {
                const pct = Math.round(((m.costUsd || m.tokens) / modelTotal) * 100);
                return (
                  <div key={m.model} className={styles.model}>
                    <div className={styles.modelName}>{m.model}</div>
                    <div className={styles.bar}>
                      <div className={styles.barFill} style={{ width: `${pct}%` }} />
                    </div>
                    <div className={styles.modelFoot}>
                      <span className={styles.mono}>
                        {pct}% · {insK(m.tokens)}
                      </span>
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

          <Panel title="Needs attention" meta={`${summary.recent.length} runs`}>
            <div className={styles.activity}>
              {summary.recent.map((a) => {
                const clickable = Boolean(a.automationRef && onOpenRun);
                const body = (
                  <>
                    <span className={cx(styles.actAgo, styles.mono)}>
                      {relativeTime(new Date(a.startedAt).toISOString())}
                    </span>
                    <div className={styles.actBody}>
                      <div className={styles.actApp}>
                        <span className={styles.tag}>{insKindLabel(a.kind)}</span>
                        <span>{a.ok ? '' : ' · failed'}</span>
                        {a.provider ? (
                          <span className={styles.actProv}> · {a.provider}</span>
                        ) : null}
                      </div>
                      <div className={styles.actNote}>{a.label}</div>
                    </div>
                    <div className={styles.actCost}>
                      <span className={styles.mono}>{insUsd(a.costUsd)}</span>
                      <span className={cx(styles.mono, styles.actUsd)}>{insK(a.tokens)}</span>
                    </div>
                  </>
                );
                return clickable ? (
                  <button
                    key={a.runId}
                    type="button"
                    className={cx(styles.act, styles.actBtn)}
                    onClick={() => onOpenRun!(a.automationRef!, a.runId)}
                  >
                    {body}
                  </button>
                ) : (
                  <div key={a.runId} className={styles.act}>
                    {body}
                  </div>
                );
              })}
              {summary.recent.length === 0 ? <PanelEmpty message="No activity yet." /> : null}
            </div>
          </Panel>
        </div>
      </div>

      <ResourceReceiptPanel usage={resourceUsage} />

      <p className={styles.footnote}>
        Completed runs in this vault only. Agent-reported costs come from the runner; estimates use
        public model rates. Incomplete data is never treated as free.
      </p>
    </div>
  );
}
