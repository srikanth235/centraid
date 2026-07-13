import type { JSX } from 'react';
import type { AlertHistoryRowDTO } from '../shell/routes/gatewayData.js';
import styles from './GatewayScreen.module.css';

/**
 * Alert history — the durable counterpart of the Gateway page Overview
 * tab's Outage log (issue #351 wave 4): persisted under Electron userData,
 * so it survives a restart instead of resetting to empty every launch.
 * Covers every alert-worthy signal, not just up/down — degraded latency,
 * component errors, and version skew land here too, each entry marked when
 * it predates this launch.
 */
export default function AlertHistoryPanel({ rows }: { rows: AlertHistoryRowDTO[] }): JSX.Element {
  return (
    <section className={styles.panel} data-testid="alert-history-panel">
      <div className={styles.panelHead}>
        <h2>Alert history</h2>
        <span className={styles.panelMeta}>persists across restarts</span>
      </div>
      {rows.length > 0 ? (
        <div className={styles.outages}>
          {rows.map((row) => (
            <div key={row.id} className={styles.outage} data-testid="alert-history-row">
              <span className={styles.outageDot} data-kind={row.kind} />
              <span className={styles.outageStart}>{row.timeLabel}</span>
              <span className={styles.outageDuration}>
                {row.kindLabel}
                {row.detail ? ` — ${row.detail}` : ''}
                {row.durationLabel ? ` (${row.durationLabel})` : ''}
              </span>
              {row.previousSession ? (
                <span className={styles.outageBadge}>earlier session</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.panelEmpty}>
          No alerts recorded yet. Down/degraded/recovered transitions and component or
          version-mismatch alerts land here, and stick around across restarts.
        </div>
      )}
    </section>
  );
}
