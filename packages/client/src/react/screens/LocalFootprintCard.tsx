import { useMemo, useState, type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import gwStyles from './GatewayScreen.module.css';
import styles from './LocalFootprintCard.module.css';
import a11y from '../styles/a11y.module.css';
import type { LocalUsageReportDTO } from '../../gateway-client-local-storage.js';
import {
  COMPONENT_PRESENTATION,
  budgetSummary,
  footprintScale,
  footprintSlices,
  formatBytes,
} from './localUsageView.js';

// Storage → Footprint (issue #544): what Centraid is using on THIS machine,
// split by component. The page's opening statement, so it leads with one
// figure and one rail rather than a table — "how much, and how close to the
// line" is the question; the breakdown is the follow-up.
//
// The rail is drawn against the owner's budget when they set one, and against
// the physical disk otherwise (see `footprintScale` for why never against
// free space). Over budget, the fill hatches rather than merely reddening:
// crossing a line the owner drew themselves should look like crossing it.

export interface LocalFootprintCardProps {
  report: LocalUsageReportDTO | null;
  loadError: string | null;
  /** Full re-walk — an explicit owner action, never a poll. */
  onRescan: () => void;
  rescanning: boolean;
}

function OccupancyRail({ report }: { report: LocalUsageReportDTO }): JSX.Element {
  const scale = footprintScale(report);
  const slices = footprintSlices(report);

  if (scale.kind === 'none') {
    return <div className={controlsCss.note}>Nothing measurable on this volume yet.</div>;
  }

  return (
    <div className={styles.rail} data-over={scale.over || undefined}>
      <div className={styles.railTrack}>
        {/* The bar is a row of hue segments, not an image: the reading it used
            to fake with `role="img"` is real text now (absolutely positioned,
            so it is not a flex item and costs no gap). */}
        <span className={a11y.srOnly}>
          {`${formatBytes(report.totalBytes)} used of ${formatBytes(scale.againstBytes ?? 0)}`}
        </span>
        {/* Each component keeps its own hue; widths are shares of the SCALE,
            not of the total, so the bar and the denominator agree. */}
        {slices.map((slice) => (
          <span
            key={slice.component}
            className={styles.railSegment}
            style={{
              width: `${(slice.fraction * scale.fillFraction * 100).toFixed(3)}%`,
              background: slice.color,
            }}
            title={`${slice.label} — ${formatBytes(slice.bytes)}`}
          />
        ))}
        {scale.warnFraction !== null ? (
          <span
            className={styles.railWarnMark}
            style={{ left: `${(scale.warnFraction * 100).toFixed(2)}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className={styles.railFoot}>
        <span>0</span>
        <span className={styles.railCap}>
          {formatBytes(scale.againstBytes ?? 0)}
          <span className={styles.railCapKind}>
            {scale.kind === 'budget' ? 'budget' : 'this disk'}
          </span>
        </span>
      </div>
    </div>
  );
}

function VaultBreakdown({ report }: { report: LocalUsageReportDTO }): JSX.Element | null {
  if (report.vaults.length === 0) return null;
  return (
    <details className={styles.byVault} data-testid="footprint-by-vault">
      <summary>By vault</summary>
      <div className={styles.byVaultBody}>
        {report.vaults.map((vault) => (
          <div key={vault.vaultId} className={styles.vaultRow}>
            <div className={styles.vaultHead}>
              <span className={styles.vaultName}>{vault.name ?? vault.vaultId.slice(0, 8)}</span>
              <span className={styles.figure}>{formatBytes(vault.bytes)}</span>
            </div>
            <div className={styles.vaultParts}>
              {vault.components
                .filter((c) => c.bytes > 0)
                .sort((a, b) => b.bytes - a.bytes)
                .map((component) => (
                  <span key={component.component} className={styles.vaultPart}>
                    <i
                      className={styles.chip}
                      style={{ background: COMPONENT_PRESENTATION[component.component].color }}
                    />
                    {COMPONENT_PRESENTATION[component.component].label}
                    <b className={styles.figure}>{formatBytes(component.bytes)}</b>
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

export default function LocalFootprintCard({
  report,
  loadError,
  onRescan,
  rescanning,
}: LocalFootprintCardProps): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  const slices = useMemo(() => (report ? footprintSlices(report) : []), [report]);

  return (
    <section className={cx(gwStyles.panel, styles.card)} data-testid="local-footprint-card">
      <div className={gwStyles.panelHead}>
        <h2>On this machine</h2>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
          disabled={rescanning || !report}
          onClick={onRescan}
        >
          <span className={styles.rescanIcon} data-spin={rescanning || undefined}>
            <Icon name={rescanning ? 'Loader' : 'Refresh'} size={13} />
          </span>
          <span>{rescanning ? 'Measuring…' : 'Rescan'}</span>
        </button>
      </div>

      <div className={styles.body}>
        {loadError ? (
          <div className={styles.loadError}>Couldn’t measure local storage: {loadError}</div>
        ) : !report ? (
          <div className={gwStyles.panelEmpty}>Measuring what’s on disk…</div>
        ) : (
          <>
            <div className={styles.headline} data-status={report.limit.status}>
              <span className={styles.headlineFigure}>{formatBytes(report.totalBytes)}</span>
              <span className={styles.headlineNote}>{budgetSummary(report, report.limits)}</span>
            </div>

            <OccupancyRail report={report} />

            {report.error ? (
              <div className={styles.staleNote}>
                Last measurement failed ({report.error}) — showing the previous figures.
              </div>
            ) : null}

            <div className={styles.legend} data-testid="footprint-legend">
              {slices.map((slice, index) => {
                const open = expanded === slice.component;
                return (
                  <button
                    key={slice.component}
                    type="button"
                    className={styles.legendRow}
                    style={{ animationDelay: `${index * 40}ms` }}
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : slice.component)}
                  >
                    <i className={styles.chip} style={{ background: slice.color }} />
                    <span className={styles.legendLabel}>{slice.label}</span>
                    <span className={styles.legendShare}>
                      {(slice.fraction * 100).toFixed(slice.fraction >= 0.1 ? 0 : 1)}%
                    </span>
                    <span className={cx(styles.figure, styles.legendBytes)}>
                      {formatBytes(slice.bytes)}
                    </span>
                    {open ? (
                      <span className={styles.legendBlurb}>
                        {slice.blurb}
                        {slice.unreadable
                          ? ` Part of this tree is unreadable (${slice.unreadable}), so the figure is a floor.`
                          : ''}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <VaultBreakdown report={report} />

            {report.disk ? (
              <div className={styles.diskLine}>
                <Icon name="Gauge" size={13} />
                <span>
                  {formatBytes(report.disk.freeBytes)} free of {formatBytes(report.disk.totalBytes)}{' '}
                  on this disk
                </span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
