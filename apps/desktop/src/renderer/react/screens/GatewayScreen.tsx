import type { JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import {
  ALERT_PRESETS,
  availabilityPct,
  buildOutageRows,
  formatAgo,
  formatClock,
  formatDuration,
  formatUptime,
  thresholdLabel,
  type GatewayRuntimeSnapshot,
} from '../shell/routes/gatewayData.js';
import styles from './GatewayScreen.module.css';

// The Gateway runtime page — a calm instrument panel over the main-process
// heartbeat monitor. Reads as a cockpit gauge cluster: a breathing status
// orb, the gateway's own uptime clock ticking in mono, a heartbeat strip of
// recent probes, the session outage log, and the down-alert control
// (threshold presets, 2-minute default). Pure: snapshot + now in, settings
// patches out through the two callbacks.

export interface GatewayScreenProps {
  snapshot: GatewayRuntimeSnapshot;
  /** Live clock (route ticks it each second) — drives the running counters. */
  now: number;
  /** True while a settings write is in flight — the alert card locks. */
  savingAlert?: boolean;
  onAlertSecondsChange: (seconds: number) => void;
  onAlertsEnabledChange: (enabled: boolean) => void;
}

const STATUS_WORD: Record<GatewayRuntimeSnapshot['status'], string> = {
  up: 'Operational',
  down: 'Unreachable',
  unknown: 'Listening…',
};

/** Only the tail of the sample ring fits the strip comfortably. */
const STRIP_SAMPLES = 120;

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className={styles.figure}>
      <div className={styles.figureLabel}>{label}</div>
      <div className={styles.figureValue}>{value}</div>
      {sub ? <div className={styles.figureSub}>{sub}</div> : null}
    </div>
  );
}

export default function GatewayScreen(props: GatewayScreenProps): JSX.Element {
  const { snapshot, now } = props;
  const status = snapshot.status;

  // The gateway's own uptime clock, advanced from the last heartbeat so it
  // ticks between polls. Server-reported, so a desktop/gateway clock skew
  // can't distort it.
  const uptimeMs =
    status === 'up' && snapshot.gatewayUptimeMs !== undefined && snapshot.lastCheckAt !== undefined
      ? snapshot.gatewayUptimeMs + Math.max(0, now - snapshot.lastCheckAt)
      : undefined;
  const availability = availabilityPct(snapshot);
  const outageRows = buildOutageRows(snapshot, now);
  const samples = snapshot.samples.slice(-STRIP_SAMPLES);
  const stripSpanMs =
    samples.length >= 2 ? (samples[samples.length - 1]?.at ?? 0) - (samples[0]?.at ?? 0) : 0;
  const alert = snapshot.alert;
  const hasPreset = ALERT_PRESETS.some((p) => p.seconds === alert.thresholdSeconds);

  return (
    <div className={styles.page} data-status={status}>
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

      {/* Hero — orb + status word on the left, the gauge cluster on the right,
          heartbeat strip across the bottom. */}
      <section className={styles.hero}>
        <div className={styles.heroTop}>
          <div className={styles.statusCluster}>
            <span className={styles.orb} aria-hidden="true">
              <span className={styles.orbCore} />
            </span>
            <div>
              <div className={styles.statusWord}>{STATUS_WORD[status]}</div>
              <div className={styles.statusSub}>
                {snapshot.statusSince !== undefined
                  ? `for ${formatDuration(now - snapshot.statusSince)} · `
                  : ''}
                {snapshot.gatewayKind} gateway “{snapshot.gatewayLabel}”
              </div>
              {status === 'down' && snapshot.lastError ? (
                <div className={styles.statusError}>{snapshot.lastError}</div>
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
                status === 'up' && snapshot.latencyMs !== undefined
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

        <div className={styles.col}>
          {/* Down alert — the configurable notification threshold. */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2>Down alert</h2>
              <span className={styles.panelMeta}>default 2m</span>
            </div>
            <div className={styles.alertBody}>
              <div className={styles.alertToggleRow}>
                <div>
                  <div className={styles.alertToggleLabel}>Alert when unreachable</div>
                  <div className={styles.alertToggleSub}>
                    A system notification fires once per outage — even with this window in the
                    background — and again when the gateway recovers.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={alert.enabled}
                  aria-label="Alert when unreachable"
                  className={styles.switch}
                  data-on={alert.enabled || undefined}
                  disabled={props.savingAlert}
                  onClick={() => props.onAlertsEnabledChange(!alert.enabled)}
                >
                  <span className={styles.switchThumb} />
                </button>
              </div>
              <div className={styles.alertAfter} data-disabled={!alert.enabled || undefined}>
                <div className={styles.alertAfterLabel}>after unreachable for</div>
                <div className={styles.presets}>
                  {ALERT_PRESETS.map((p) => (
                    <button
                      key={p.seconds}
                      type="button"
                      className={cx(
                        styles.preset,
                        p.seconds === alert.thresholdSeconds && styles.presetActive,
                      )}
                      disabled={props.savingAlert || !alert.enabled}
                      onClick={() => props.onAlertSecondsChange(p.seconds)}
                    >
                      {p.label}
                    </button>
                  ))}
                  {!hasPreset ? (
                    <span className={cx(styles.preset, styles.presetActive)}>
                      {thresholdLabel(alert.thresholdSeconds)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
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
          </section>
        </div>
      </div>
    </div>
  );
}
