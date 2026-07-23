import { useRef, useState, type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import {
  availabilityPct,
  buildOutageRows,
  formatAgo,
  formatClock,
  formatDuration,
  formatUptime,
  reconcileStatus,
  type GatewayRuntimeSnapshot,
  type ReconciledStatus,
} from '../shell/routes/gatewayData.js';
import SettingsDiagnosticsScreen, {
  type GatewayHealthDTO,
  type SettingsDiagnosticsBridgeProps,
} from './SettingsDiagnosticsScreen.js';
import LogsScreen, { type LogsBridgeProps } from './LogsScreen.js';
import DevicesCard, { type DevicesCardProps } from './DevicesCard.js';
import GatewayAlertsTab from './GatewayAlertsTab.js';
import RestartGatewayButton from './RestartGatewayButton.js';
import ResourceModeCard, {
  type ResourceMode,
  type ResourceModeCardProps,
} from './ResourceModeCard.js';
import styles from './GatewayScreen.module.css';

// Gateway runtime, component health, paired devices, logs, and alerts share
// one instrument panel (#341/#344/#347). Backup/storage custody used to live
// on the Overview tab too; it's its own page now (BackupsScreen) — "is the
// gateway up" and "are my bytes safe" are different questions.

export interface GatewayScreenProps {
  snapshot: GatewayRuntimeSnapshot;
  /** Live clock (route ticks it each second) — drives the running counters. */
  now: number;
  /** True while a settings write is in flight — the alert card locks. */
  savingAlert?: boolean;
  onAlertSecondsChange: (seconds: number) => void;
  onAlertsEnabledChange: (enabled: boolean) => void;
  /** Optional launch-at-login toggle; defaults false for older hosts/tests. */
  launchAtLogin?: boolean;
  onLaunchAtLoginChange?: (enabled: boolean) => void;
  /** True while the launch-at-login write is in flight — locks just that switch. */
  savingLaunchAtLogin?: boolean;
  /** Polled component-health summary — reconciles the Overview orb and
   *  badges the Components tab. `null` before the first poll lands. */
  health: GatewayHealthDTO | null;
  loadHealth: SettingsDiagnosticsBridgeProps['loadHealth'];
  streamLogs: LogsBridgeProps['streamLogs'];
  /** Paired-devices card data (Overview tab) — `GET/DELETE _gateway/devices`.
   *  Optional so callers/tests that predate the card render the tab
   *  unchanged; the card is simply omitted when unwired. */
  loadDevices?: DevicesCardProps['loadDevices'];
  onRevokeDevice?: DevicesCardProps['onRevokeDevice'];
  onCurrentDeviceRevoked?: DevicesCardProps['onCurrentDeviceRevoked'];
  onCreateDeviceTicket?: DevicesCardProps['onCreateTicket'];
  onUpdateDeviceCompute?: DevicesCardProps['onUpdateCompute'];
  loadDeviceWorkStatus?: DevicesCardProps['loadWorkStatus'];
  /**
   * Restart the local embedded gateway (Overview tab, near the runtime
   * status). Refused for a remote gateway — main answers `{ok: false}`
   * with an explanation, rendered inline rather than thrown.
   */
  onRestartGateway: () => Promise<{ ok: boolean; error?: string }>;
  /** Save `/centraid/_gateway/diagnostics` through a native dialog (Logs
   *  tab toolbar). `canceled` when the user dismissed the dialog. */
  onExportDiagnostics: LogsBridgeProps['onExportDiagnostics'];
  /**
   * Resource mode (#521) — durable owner preference for how hard the gateway
   * may use this machine. Optional so older hosts/tests keep rendering.
   */
  loadResourceMode?: () => Promise<ResourceMode>;
  saveResourceMode?: (mode: ResourceMode) => Promise<void>;
  /**
   * Pause / resume background work (issue #528 Phase B). Optional so older
   * hosts/tests keep rendering; the pause control also gates on the health
   * snapshot carrying `metrics.backgroundPause`.
   */
  onPauseBackgroundWork?: (
    durationMs?: number,
  ) => Promise<{ paused: boolean; until: string | null }>;
  onResumeBackgroundWork?: () => Promise<{ paused: boolean }>;
  /**
   * L3 "Tune" rung knob overrides (issue #528 Phase F). Optional so older
   * hosts/tests keep rendering; the Advanced section also gates on the health
   * profile carrying `sources` + `bounds`.
   */
  loadKnobPrefs?: ResourceModeCardProps['loadKnobPrefs'];
  saveKnobPrefs?: ResourceModeCardProps['saveKnobPrefs'];
}

type TabId = 'overview' | 'components' | 'logs' | 'alerts';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'components', label: 'Components' },
  { id: 'logs', label: 'Logs' },
  { id: 'alerts', label: 'Alerts' },
];

const STATUS_WORD: Record<ReconciledStatus, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Unreachable',
  unknown: 'Listening…',
};

/** Only the tail of the sample ring fits the strip comfortably. */
const STRIP_SAMPLES = 120;

function Figure({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}): JSX.Element {
  return (
    <div className={styles.figure}>
      <div className={styles.figureLabel}>{label}</div>
      <div className={styles.figureValue}>{value}</div>
      {sub ? <div className={styles.figureSub}>{sub}</div> : null}
    </div>
  );
}

export default function GatewayScreen(props: GatewayScreenProps): JSX.Element {
  const { snapshot, now, health } = props;
  const heartbeat = snapshot.status;
  const overall = reconcileStatus(heartbeat, health);
  const unhealthyCount = health ? health.components.filter((c) => c.status !== 'ok').length : 0;

  const [tab, setTab] = useState<TabId>('overview');
  const [logsFocus, setLogsFocus] = useState<{ text: string; nonce: number } | undefined>(
    undefined,
  );
  const jumpNonceRef = useRef(0);
  const jumpToLogs = (component: string): void => {
    jumpNonceRef.current += 1;
    setLogsFocus({ text: component, nonce: jumpNonceRef.current });
    setTab('logs');
  };

  // The gateway's own uptime clock, advanced from the last heartbeat so it
  // ticks between polls. Server-reported, so a desktop/gateway clock skew
  // can't distort it. Keyed off the raw heartbeat, not the reconciled
  // status — a degraded component doesn't blank the uptime figure.
  const uptimeMs =
    heartbeat === 'up' &&
    snapshot.gatewayUptimeMs !== undefined &&
    snapshot.lastCheckAt !== undefined
      ? snapshot.gatewayUptimeMs + Math.max(0, now - snapshot.lastCheckAt)
      : undefined;
  const availability = availabilityPct(snapshot);
  const outageRows = buildOutageRows(snapshot, now);
  const samples = snapshot.samples.slice(-STRIP_SAMPLES);
  const stripSpanMs =
    samples.length >= 2 ? (samples[samples.length - 1]?.at ?? 0) - (samples[0]?.at ?? 0) : 0;

  return (
    <div className={styles.page} data-status={overall}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="Cellular" size={16} />
          </span>
          <h1>Gateway</h1>
        </div>
        <div className={styles.headMeta}>
          heartbeat · every {Math.round(snapshot.pollIntervalMs / 1000)}s
          {snapshot.lastCheckAt !== undefined
            ? ` · checked ${formatAgo(snapshot.lastCheckAt, now)}`
            : ''}
        </div>
      </div>

      <nav className={styles.tabs} role="tablist" aria-label="Gateway">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cx(styles.tab, tab === t.id && styles.tabActive)}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'components' && unhealthyCount > 0 ? (
              <span className={styles.tabBadge}>{unhealthyCount}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <>
          {/* Hero — orb + status word on the left, the gauge cluster on the
              right, heartbeat strip across the bottom. */}
          <section className={styles.hero}>
            <div className={styles.heroTop}>
              <div className={styles.statusCluster}>
                <span className={styles.orb} aria-hidden="true">
                  <span className={styles.orbCore} />
                </span>
                <div>
                  <div className={styles.statusWord}>{STATUS_WORD[overall]}</div>
                  <div className={styles.statusSub}>
                    {snapshot.statusSince !== undefined
                      ? `for ${formatDuration(now - snapshot.statusSince)} · `
                      : ''}
                    {snapshot.gatewayKind} gateway “{snapshot.gatewayLabel}”
                  </div>
                  {heartbeat === 'down' && snapshot.lastError ? (
                    <div className={styles.statusError}>{snapshot.lastError}</div>
                  ) : null}
                  {overall === 'degraded' ? (
                    <div className={styles.statusDegraded}>
                      {unhealthyCount} component{unhealthyCount === 1 ? '' : 's'} reporting trouble
                      — see Components
                    </div>
                  ) : null}
                </div>
              </div>
              <div className={styles.figures}>
                <Figure
                  label="Gateway uptime"
                  value={uptimeMs !== undefined ? formatUptime(uptimeMs) : '——'}
                  {...(snapshot.gatewayStartedAt !== undefined && uptimeMs !== undefined
                    ? { sub: `since ${formatClock(now - uptimeMs)}` }
                    : {})}
                />
                <Figure
                  label="Latency"
                  value={
                    heartbeat === 'up' && snapshot.latencyMs !== undefined
                      ? `${snapshot.latencyMs} ms`
                      : '——'
                  }
                />
                <Figure
                  label="Availability"
                  value={availability !== undefined ? `${availability.toFixed(1)}%` : '——'}
                  sub={`${snapshot.checksTotal} checks this session`}
                />
              </div>
            </div>

            <div className={styles.strip} role="img" aria-label="Recent heartbeat results">
              {samples.length > 0 ? (
                samples.map((s) => (
                  <span
                    key={s.at}
                    className={styles.beat}
                    data-ok={s.ok ? 'true' : 'false'}
                    title={`${formatClock(s.at)} — ${s.ok ? `ok, ${s.latencyMs ?? '—'} ms` : 'no answer'}`}
                  />
                ))
              ) : (
                <span className={styles.stripEmpty}>waiting for the first heartbeat…</span>
              )}
            </div>
            <div className={styles.stripAxis}>
              <span>{stripSpanMs > 0 ? `${formatDuration(stripSpanMs)} ago` : ''}</span>
              <span>now</span>
            </div>
          </section>

          <div className={styles.grid}>
            {/* Outage log — every stretch of missed heartbeats this session. */}
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2>Outage log</h2>
                <span className={styles.panelMeta}>
                  since {formatClock(snapshot.trackingSince)} · {snapshot.checksFailed} failed{' '}
                  {snapshot.checksFailed === 1 ? 'check' : 'checks'}
                </span>
              </div>
              {outageRows.length > 0 ? (
                <div className={styles.outages}>
                  {outageRows.map((o) => (
                    <div key={o.id} className={styles.outage} data-ongoing={o.ongoing || undefined}>
                      <span className={styles.outageDot} />
                      <span className={styles.outageStart}>{o.startedLabel}</span>
                      <span className={styles.outageDuration}>
                        {o.durationLabel}
                        {o.ongoing ? ' — ongoing' : ''}
                      </span>
                      {o.alerted ? <span className={styles.outageBadge}>notified</span> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.panelEmpty}>
                  No downtime recorded this session. The log resets when the app relaunches or you
                  switch gateways.
                </div>
              )}
            </section>

            {/* Identity — what the heartbeat is talking to. */}
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2>Identity</h2>
              </div>
              <dl className={styles.idList}>
                <div className={styles.idRow}>
                  <dt>Gateway</dt>
                  <dd>{snapshot.gatewayLabel}</dd>
                </div>
                <div className={styles.idRow}>
                  <dt>Kind</dt>
                  <dd className={styles.idMono}>{snapshot.gatewayKind}</dd>
                </div>
                <div className={styles.idRow}>
                  <dt>Version</dt>
                  <dd className={styles.idMono}>
                    {snapshot.version ?? '—'}
                    {snapshot.schemaEpoch !== undefined ? ` · epoch ${snapshot.schemaEpoch}` : ''}
                  </dd>
                </div>
                <div className={styles.idRow}>
                  <dt>Started</dt>
                  <dd className={styles.idMono}>
                    {uptimeMs !== undefined ? formatClock(now - uptimeMs) : '—'}
                  </dd>
                </div>
                <div className={styles.idRow}>
                  <dt>Checks</dt>
                  <dd className={styles.idMono}>
                    {snapshot.checksTotal} run · {snapshot.checksFailed} failed
                  </dd>
                </div>
              </dl>
              <div className={styles.idFooter}>
                <RestartGatewayButton onRestart={props.onRestartGateway} />
              </div>
            </section>

            {props.loadResourceMode && props.saveResourceMode ? (
              <ResourceModeCard
                loadMode={props.loadResourceMode}
                saveMode={props.saveResourceMode}
                {...(health?.metrics?.hardwareProfileClass
                  ? { resolvedClass: health.metrics.hardwareProfileClass }
                  : {})}
                {...(health?.metrics?.resourceMode
                  ? { activeMode: health.metrics.resourceMode }
                  : {})}
                {...(health?.metrics?.resourceProfile
                  ? { resourceProfile: health.metrics.resourceProfile }
                  : {})}
                {...(health?.metrics?.backgroundPause
                  ? { backgroundPause: health.metrics.backgroundPause }
                  : {})}
                {...(health?.metrics?.powerContext
                  ? { powerContext: health.metrics.powerContext }
                  : {})}
                {...(props.onPauseBackgroundWork ? { onPause: props.onPauseBackgroundWork } : {})}
                {...(props.onResumeBackgroundWork
                  ? { onResume: props.onResumeBackgroundWork }
                  : {})}
                {...(props.loadKnobPrefs ? { loadKnobPrefs: props.loadKnobPrefs } : {})}
                {...(props.saveKnobPrefs ? { saveKnobPrefs: props.saveKnobPrefs } : {})}
              />
            ) : null}

            {/* Paired devices and their contributed-compute status (#392/#414). */}
            {props.loadDevices && props.onRevokeDevice ? (
              <DevicesCard
                now={now}
                loadDevices={props.loadDevices}
                onRevokeDevice={props.onRevokeDevice}
                {...(props.onCurrentDeviceRevoked
                  ? { onCurrentDeviceRevoked: props.onCurrentDeviceRevoked }
                  : {})}
                {...(props.onCreateDeviceTicket
                  ? { onCreateTicket: props.onCreateDeviceTicket }
                  : {})}
                {...(props.onUpdateDeviceCompute
                  ? { onUpdateCompute: props.onUpdateDeviceCompute }
                  : {})}
                {...(props.loadDeviceWorkStatus
                  ? { loadWorkStatus: props.loadDeviceWorkStatus }
                  : {})}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {tab === 'components' ? (
        <div className={styles.tabPane}>
          <SettingsDiagnosticsScreen loadHealth={props.loadHealth} onJumpToLogs={jumpToLogs} />
        </div>
      ) : null}

      {tab === 'logs' ? (
        <div className={styles.tabPane}>
          <LogsScreen
            streamLogs={props.streamLogs}
            focusQuery={logsFocus}
            onExportDiagnostics={props.onExportDiagnostics}
          />
        </div>
      ) : null}

      {tab === 'alerts' ? (
        <GatewayAlertsTab
          snapshot={snapshot}
          savingAlert={props.savingAlert}
          onAlertSecondsChange={props.onAlertSecondsChange}
          onAlertsEnabledChange={props.onAlertsEnabledChange}
          launchAtLogin={props.launchAtLogin}
          savingLaunchAtLogin={props.savingLaunchAtLogin}
          {...(props.onLaunchAtLoginChange
            ? { onLaunchAtLoginChange: props.onLaunchAtLoginChange }
            : {})}
        />
      ) : null}
    </div>
  );
}
