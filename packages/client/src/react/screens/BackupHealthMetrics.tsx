import { useState, type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import { formatBytes } from '../../format.js';
import { formatDuration } from '../shell/routes/gatewayData.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import type { StorageMetrics } from '../../storage-metrics.js';
import styles from './BackupCard.module.css';

// The five-metric health surface (issue #436 §6) — the ONE story the Backups
// page tells about your data's safety, in exactly five readouts and nothing
// else. Every metric here maps 1:1 to `deriveStorageMetrics`'s output; the raw
// custody clocks that feed Freshness live behind the card's Diagnostics
// disclosure, never on this primary surface. Store-class vocabulary (CAS,
// backup vs. derived tiers, storage classes) is deliberately absent — a home
// bundle is one thing to the person who owns it.

export interface BackupHealthMetricsProps {
  metrics: StorageMetrics;
  now: number;
}

/** Freshness status → the status color token (there is no `red` token —
 *  `--danger` is the repo's danger hue; amber + success round out the set). */
const STATUS_TONE: Record<StorageMetrics['freshness']['status'], string> = {
  green: 'ok',
  yellow: 'warn',
  red: 'bad',
  unknown: 'unknown',
};

function FreshnessMetric({ metrics, now }: { metrics: StorageMetrics; now: number }): JSX.Element {
  const { status, tMs } = metrics.freshness;
  const tone = STATUS_TONE[status];
  const line =
    status === 'unknown' || tMs === null
      ? 'Not yet proven safe offsite'
      : `Everything safe as of ${formatDuration(Math.max(0, now - tMs))} ago`;
  return (
    <div className={styles.metric} data-testid="metric-freshness">
      <span className={styles.metricDot} data-tone={tone} />
      <div className={styles.metricBody}>
        <span className={styles.metricValue} data-tone={tone}>
          {line}
        </span>
        <span className={styles.metricLabel}>Freshness</span>
      </div>
    </div>
  );
}

function RecoveryMetric({ metrics }: { metrics: StorageMetrics }): JSX.Element | null {
  const { days } = metrics.recoveryWindow;
  if (days === null) return null;
  return (
    <div className={styles.metric} data-testid="metric-recovery">
      <span className={styles.metricIcon}>
        <Icon name="History" size={15} />
      </span>
      <div className={styles.metricBody}>
        <span className={styles.metricValue}>Undo anything from the last {days} days</span>
        <span className={styles.metricLabel}>Recovery window</span>
      </div>
    </div>
  );
}

function PrivacyMetric(): JSX.Element {
  return (
    <div className={styles.metric} data-testid="metric-privacy">
      <span className={styles.metricIcon}>
        <Icon name="Key" size={15} />
      </span>
      <div className={styles.metricBody}>
        <span className={styles.metricValue}>Your provider cannot read your data</span>
        <span className={styles.metricLabel}>Privacy</span>
        <details className={styles.metricHow}>
          <summary>How</summary>
          <p>
            Every byte is sealed on your device before it leaves. The provider only ever stores
            ciphertext, and the keys that decrypt it never leave your devices.
          </p>
        </details>
      </div>
    </div>
  );
}

function CostMetric({ metrics }: { metrics: StorageMetrics }): JSX.Element {
  const { bytesStored, quotaBytes, fractionUsed } = metrics.cost;
  if (quotaBytes === null || fractionUsed === null) {
    return (
      <div className={styles.metric} data-testid="metric-cost">
        <span className={styles.metricIcon}>
          <Icon name="Gauge" size={15} />
        </span>
        <div className={styles.metricBody}>
          <span className={styles.metricValue}>{formatBytes(bytesStored)} stored</span>
          <span className={styles.metricLabel}>Cost · unmetered</span>
        </div>
      </div>
    );
  }
  const pct = Math.min(100, Math.round(fractionUsed * 100));
  const severity = pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div className={styles.metric} data-testid="metric-cost">
      <span className={styles.metricIcon}>
        <Icon name="Gauge" size={15} />
      </span>
      <div className={styles.metricBody}>
        <span className={styles.metricValue}>
          {formatBytes(bytesStored)} of {formatBytes(quotaBytes)}
        </span>
        <div className={styles.costTrack} data-severity={severity} data-testid="cost-bar">
          <span className={styles.costFill} style={{ width: `${pct}%` }} />
        </div>
        <span className={styles.metricLabel}>Cost · {pct}% used</span>
      </div>
    </div>
  );
}

function ExitMetric({ metrics }: { metrics: StorageMetrics }): JSX.Element {
  const [open, setOpen] = useState(false);
  const metered = metrics.exit.restoreCostClass === 'metered-egress';
  return (
    <div className={styles.metric} data-testid="metric-exit">
      <span className={styles.metricIcon}>
        <Icon name="Share" size={15} />
      </span>
      <div className={styles.metricBody}>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft, styles.exitBtn)}
          onClick={() => setOpen((v) => !v)}
          data-testid="export-everything"
        >
          <Icon name="Share" size={13} />
          <span>Export everything</span>
        </button>
        <span className={styles.metricLabel}>Exit</span>
        {metered ? (
          <span className={styles.exitMeteredNote} data-testid="exit-metered-note">
            Your provider charges for download bandwidth — a full export is priced before it starts.
          </span>
        ) : null}
        {open ? (
          <p className={styles.exitHow}>
            Your data is always yours to take. Originals stay sealed on your devices, and the
            recovery kit plus the provider&rsquo;s object listing reconstruct everything offsite —
            no provider approval, no lock-in.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** One row of the Diagnostics disclosure's clock grid — a freshness input
 *  clock, labelled, relative to now. Lives here (not BackupCard) because the
 *  four clocks are the diagnostics face of the Freshness metric. */
export function ClockLine({
  label,
  at,
  now,
}: {
  label: string;
  at: number | null;
  now: number;
}): JSX.Element {
  return (
    <div className={styles.clockLine}>
      <span>{label}</span>
      <span>{at === null ? 'never' : `${formatDuration(Math.max(0, now - at))} ago`}</span>
    </div>
  );
}

export default function BackupHealthMetrics({
  metrics,
  now,
}: BackupHealthMetricsProps): JSX.Element {
  return (
    <div className={styles.metrics} data-testid="backup-health-metrics">
      <FreshnessMetric metrics={metrics} now={now} />
      <RecoveryMetric metrics={metrics} />
      <PrivacyMetric />
      <CostMetric metrics={metrics} />
      <ExitMetric metrics={metrics} />
    </div>
  );
}
