import type { JSX } from 'react';
import { relativeTime } from '../format.js';
import {
  processUsageRows,
  subsystemUsageRows,
  type ResourceUsageDTO,
  type ResourceUsageRow,
} from './resource-summary.js';
import styles from './ResourceReceiptPanel.module.css';

// Resource receipt (issue #528 Phase C): "what this vault's gateway host
// actually used" — measured proxies (CPU time, bytes, activity), rendered
// beside the cost transparency on Insights. Agent-run usage is included and
// labelled measured-but-not-throttled, so Conserve never appears to promise
// something it does not govern. No wattage: software can't measure it.
//
// The DTO is optional on health metrics — older gateways don't send it. When
// it's absent the panel renders a single quiet "not available" line so the
// section never disappears without explanation. All figures are attributed to
// the gateway host, never the local browser or phone (remote-gateway case).

export interface ResourceReceiptPanelProps {
  /** From `health.metrics.resourceUsage`; absent on older gateways. */
  usage?: ResourceUsageDTO;
}

function UsageRow({ row }: { row: ResourceUsageRow }): JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <dt className={styles.label}>{row.label}</dt>
        <dd className={styles.value}>{row.value}</dd>
      </div>
      {row.note ? <p className={styles.note}>{row.note}</p> : null}
    </div>
  );
}

export default function ResourceReceiptPanel({ usage }: ResourceReceiptPanelProps): JSX.Element {
  if (!usage) {
    return (
      <section className={styles.panel} data-testid="resource-receipt">
        <header className={styles.head}>
          <h2>Resource receipt</h2>
        </header>
        <p className={styles.unavailable}>
          Not available from this gateway. Update the gateway host to see what it actually used.
        </p>
      </section>
    );
  }

  const since = relativeTime(new Date(usage.sinceMs).toISOString());
  const process = processUsageRows(usage);
  const subsystems = subsystemUsageRows(usage);
  const wakeups = usage.backgroundTimerFiresLastHour;

  return (
    <section className={styles.panel} data-testid="resource-receipt">
      <header className={styles.head}>
        <h2>Resource receipt</h2>
        <span className={styles.meta}>since {since}</span>
      </header>
      <p className={styles.intro}>
        What this vault’s gateway host actually used — measured, not the browser or phone you’re
        reading this on.
      </p>

      <dl className={styles.list}>
        {process.map((row) => (
          <UsageRow key={row.label} row={row} />
        ))}
      </dl>

      <div className={styles.groupTitle}>Background work</div>
      <dl className={styles.list}>
        {subsystems.map((row) => (
          <UsageRow key={row.label} row={row} />
        ))}
        {wakeups !== null ? (
          <UsageRow
            key="wakeups"
            row={{ label: 'Background wakeups (last hour)', value: String(wakeups) }}
          />
        ) : null}
      </dl>

      <p className={styles.footnote}>
        These are measured proxies — CPU time, bytes moved, and time spent active. We don’t show
        watts because software alone can’t measure power draw.
      </p>
    </section>
  );
}
