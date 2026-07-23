import { type JSX } from 'react';
import { cx } from '../ui/cx.js';
import {
  ALERT_PRESETS,
  buildAlertHistoryRows,
  thresholdLabel,
  type GatewayRuntimeSnapshot,
} from '../shell/routes/gatewayData.js';
import AlertHistoryPanel from './AlertHistoryPanel.js';
import styles from './GatewayScreen.module.css';

// Gateway → Alerts tab, extracted verbatim from GatewayScreen (issue #528
// Phase F) so the Overview wiring can grow without pushing GatewayScreen past
// the 500-line cap. Behaviour-identical: the down-alert threshold form, the
// launch-at-login switch, and the alert history panel.

export interface GatewayAlertsTabProps {
  snapshot: GatewayRuntimeSnapshot;
  /** True while a settings write is in flight — the alert card locks. */
  savingAlert?: boolean;
  onAlertSecondsChange: (seconds: number) => void;
  onAlertsEnabledChange: (enabled: boolean) => void;
  /** Optional launch-at-login toggle; defaults false for older hosts/tests. */
  launchAtLogin?: boolean;
  onLaunchAtLoginChange?: (enabled: boolean) => void;
  /** True while the launch-at-login write is in flight — locks just that switch. */
  savingLaunchAtLogin?: boolean;
}

export default function GatewayAlertsTab(props: GatewayAlertsTabProps): JSX.Element {
  const { snapshot } = props;
  const alert = snapshot.alert;
  const hasPreset = ALERT_PRESETS.some((p) => p.seconds === alert.thresholdSeconds);
  const alertHistoryRows = buildAlertHistoryRows(snapshot);

  return (
    <div className={cx(styles.tabPane, styles.tabPaneForm)}>
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

      {/* Launch at login — the cheap 80% fix for "always-on" (no OS
          scheduler keeps the desktop-hosted gateway up once the app quits,
          but this brings the app itself back after a reboot/login). */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2>Launch at login</h2>
        </div>
        <div className={styles.alertBody}>
          <div className={styles.alertToggleRow}>
            <div>
              <div className={styles.alertToggleLabel}>Start Centraid at login</div>
              <div className={styles.alertToggleSub}>
                Keeps your gateway available without having to open Centraid by hand.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={props.launchAtLogin ?? false}
              aria-label="Start Centraid at login"
              className={styles.switch}
              data-on={props.launchAtLogin || undefined}
              disabled={props.savingLaunchAtLogin}
              onClick={() => props.onLaunchAtLoginChange?.(!(props.launchAtLogin ?? false))}
            >
              <span className={styles.switchThumb} />
            </button>
          </div>
        </div>
      </section>

      <AlertHistoryPanel rows={alertHistoryRows} />
    </div>
  );
}
