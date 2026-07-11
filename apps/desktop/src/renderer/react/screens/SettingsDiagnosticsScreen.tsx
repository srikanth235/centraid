import { useCallback, useEffect, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import { relativeTime } from '../format.js';
import { cx } from '../ui/cx.js';
import styles from './SettingsDiagnosticsScreen.module.css';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';

// Gateway → Components: the owner surface over the gateway's
// component-level health (`GET /centraid/_gateway/health`). Uptime says
// the process answers; this says which subsystem stopped working — vaults,
// schedulers, outbox, connections — with each component's last error and
// the gateway's recent structured warn/error tail. Prop-driven like
// SettingsProvidersScreen: this file owns the view + load/refresh state,
// the gateway I/O lives in `routes/settingsDiagnosticsData.ts`. Mounted from
// the Gateway page's Components tab (GatewayScreen.tsx), not Settings.

export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface HealthComponentDTO {
  component: string;
  status: HealthStatus;
  detail?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  errorCount: number;
}

export interface HealthEventDTO {
  at: string;
  component: string;
  level: 'warn' | 'error';
  message: string;
}

export interface GatewayHealthDTO {
  status: HealthStatus;
  startedAt: string;
  uptimeMs: number;
  components: HealthComponentDTO[];
  recentEvents: HealthEventDTO[];
}

export interface SettingsDiagnosticsBridgeProps {
  loadHealth: () => Promise<GatewayHealthDTO>;
  /** Jump into the Logs tab, focused on this component's lines — omitted
   *  when the caller has nowhere to send the click (only wired from the
   *  Gateway page, where Logs is a sibling tab). */
  onJumpToLogs?: (component: string) => void;
}

const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: 'All systems go',
  degraded: 'Degraded',
  error: 'Something is failing',
};

const COMPONENT_LABEL: Record<string, string> = {
  vaults: 'Vaults',
  connections: 'Connections',
  automations: 'Automation scheduler',
  'automation-runs': 'Automation runs',
  outbox: 'Outbox',
  catalog: 'Model catalog',
  tunnel: 'Phone tunnel',
};

function componentLabel(component: string): string {
  return (
    COMPONENT_LABEL[component] ??
    component.charAt(0).toUpperCase() + component.slice(1).replace(/-/g, ' ')
  );
}

function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function eventClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ComponentRow({
  row,
  onJumpToLogs,
}: {
  row: HealthComponentDTO;
  onJumpToLogs?: (component: string) => void;
}): JSX.Element {
  // The sub-line reads the most useful thing per state: a failing
  // component shows its LAST ERROR (the actionable bit); a healthy one
  // shows its probe detail ("2 vaults mounted") or last-ok recency.
  const sub =
    row.status === 'ok'
      ? (row.detail ?? (row.lastOkAt ? `last ok ${relativeTime(row.lastOkAt)}` : undefined))
      : (row.lastError ?? row.detail);
  return (
    <div className={styles.row} data-testid="diag-component">
      <span className={styles.dot} data-health={row.status} />
      <div className={styles.rowMeta}>
        <div className={styles.rowName}>{componentLabel(row.component)}</div>
        {sub ? <div className={styles.rowSub}>{sub}</div> : null}
      </div>
      {row.errorCount > 0 ? (
        <span className={styles.errCount} title="Errors since gateway start">
          {row.errorCount} err{row.errorCount === 1 ? '' : 's'}
        </span>
      ) : null}
      {row.status !== 'ok' && onJumpToLogs ? (
        <button
          type="button"
          className={styles.jumpToLogs}
          onClick={() => onJumpToLogs(row.component)}
        >
          View in logs
        </button>
      ) : null}
      <span className={styles.healthLabel} data-health={row.status}>
        {row.status === 'ok' ? 'Healthy' : row.status === 'degraded' ? 'Degraded' : 'Failing'}
      </span>
    </div>
  );
}

export default function SettingsDiagnosticsScreen({
  loadHealth,
  onJumpToLogs,
}: SettingsDiagnosticsBridgeProps): JSX.Element {
  const [health, setHealth] = useState<GatewayHealthDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback((): void => {
    setBusy(true);
    loadHealth()
      .then((snap) => {
        setHealth(snap);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, [loadHealth]);

  useEffect(() => refresh(), [refresh]);

  if (error !== null) {
    return <div className={styles.loadError}>Couldn’t reach the gateway: {error}</div>;
  }
  if (!health) {
    return <div className={styles.loading}>Checking gateway health…</div>;
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.overall} data-health={health.status}>
        <span className={styles.dot} data-health={health.status} />
        <div className={styles.overallMeta}>
          <div className={styles.overallTitle}>{STATUS_LABEL[health.status]}</div>
          <div className={styles.overallSub}>
            Gateway up {formatUptime(health.uptimeMs)} · since{' '}
            {new Date(health.startedAt).toLocaleString()}
          </div>
        </div>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
          disabled={busy}
          onClick={refresh}
        >
          <Icon name="Refresh" size={13} />
          <span>{busy ? 'Checking…' : 'Refresh'}</span>
        </button>
      </div>

      <div className={styles.panel}>
        {health.components.length === 0 ? (
          <div className={styles.empty}>No components have reported yet.</div>
        ) : (
          health.components.map((row) => (
            <ComponentRow key={row.component} row={row} onJumpToLogs={onJumpToLogs} />
          ))
        )}
      </div>

      <div className={styles.eventsHead}>Recent warnings &amp; errors</div>
      <div className={styles.panel}>
        {health.recentEvents.length === 0 ? (
          <div className={styles.empty}>Nothing logged since the gateway started.</div>
        ) : (
          health.recentEvents.map((ev, i) => (
            <div className={styles.eventRow} key={`${ev.at}-${i}`} data-testid="diag-event">
              <span className={styles.eventTime}>{eventClock(ev.at)}</span>
              <span className={styles.eventLevel} data-level={ev.level}>
                {ev.level}
              </span>
              <span className={styles.eventComponent}>{componentLabel(ev.component)}</span>
              <span className={styles.eventMessage}>{ev.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
