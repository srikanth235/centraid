// governance: allow-repo-hygiene file-size-limit one instrument-panel screen
// (runtime + backup + storage + components + logs + alerts tabs) threading
// bridge props to each tab's own screen component — #726 P1 added one more
// (`loadOwners`, for the Storage tab's per-vault owner labels) and crossed
// the line count by two.
import { useRef, useState } from "react";
import type { JSX } from "react";

import {
  availabilityPct,
  formatAgo,
  formatClock,
  formatDuration,
  formatUptime,
  reconcileStatus,
} from "../shell/routes/gatewayData.js";
import type {
  GatewayRuntimeSnapshot,
  ReconciledStatus,
} from "../shell/routes/gatewayData.js";
import Icon from "../ui/Icon.js";
import BackupCard from "./BackupCard.js";
import type { BackupCardProps } from "./BackupCard.js";
import GatewayAlertsTab from "./GatewayAlertsTab.js";
import GatewayServiceTip from "./GatewayServiceTip.js";
import LogsScreen from "./LogsScreen.js";
import type { LogsBridgeProps } from "./LogsScreen.js";
import ResourceModeCard from "./ResourceModeCard.js";
import type {
  ResourceMode,
  ResourceModeCardProps,
} from "./ResourceModeCard.js";
import RestartGatewayButton from "./RestartGatewayButton.js";
import SettingsDiagnosticsScreen from "./SettingsDiagnosticsScreen.js";
import type {
  DiagnosticsConnectionsProps,
  GatewayHealthDTO,
  SettingsDiagnosticsBridgeProps,
} from "./SettingsDiagnosticsScreen.js";
import StorageScreen from "./StorageScreen.js";
import type { StorageScreenProps } from "./StorageScreen.js";

import styles from "./GatewayScreen.module.css";

// Gateway runtime, backup custody, local storage, component health, logs, and
// alerts share one instrument panel (#341/#344/#347/#608). Backup/recovery
// stays on Overview; footprint and limits live on Storage. People & devices
// remain on Household (#599), where their ownership context is visible.

export interface GatewayScreenProps {
  snapshot: GatewayRuntimeSnapshot;
  /** Live clock (route ticks it each second) — drives the running counters. */
  now: number;
  /** True while a settings write is in flight — the alert card locks. */
  savingAlert?: boolean;
  onAlertSecondsChange?: (seconds: number) => void;
  onAlertsEnabledChange?: (enabled: boolean) => void;
  /** Optional launch-at-login toggle; defaults false for older hosts/tests. */
  launchAtLogin?: boolean;
  onLaunchAtLoginChange?: (enabled: boolean) => void;
  /** True while the launch-at-login write is in flight — locks just that switch. */
  savingLaunchAtLogin?: boolean;
  /** Polled component-health summary — reconciles the Overview orb and
   *  badges the Components tab. `null` before the first poll lands. */
  health: GatewayHealthDTO | null;
  loadHealth: SettingsDiagnosticsBridgeProps["loadHealth"];
  /** Host plumbing for the Components tab's Connections section (issue #665).
   *  Optional so hosts with no gateway registry (and route tests) still render. */
  connections?: DiagnosticsConnectionsProps;
  streamLogs: LogsBridgeProps["streamLogs"];
  /**
   * Restart the local embedded gateway (Overview tab, near the runtime
   * status). Refused for a remote gateway — main answers `{ok: false}`
   * with an explanation, rendered inline rather than thrown.
   */
  onRestartGateway?: () => Promise<{ ok: boolean; error?: string }>;
  /** Save `/centraid/_gateway/diagnostics` through a native dialog (Logs
   *  tab toolbar). `canceled` when the user dismissed the dialog. */
  onExportDiagnostics: LogsBridgeProps["onExportDiagnostics"];
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
    durationMs?: number
  ) => Promise<{ paused: boolean; until: string | null }>;
  onResumeBackgroundWork?: () => Promise<{ paused: boolean }>;
  /**
   * L3 "Tune" rung knob overrides (issue #528 Phase F). Optional so older
   * hosts/tests keep rendering; the Advanced section also gates on the health
   * profile carrying `sources` + `bounds`.
   */
  loadKnobPrefs?: ResourceModeCardProps["loadKnobPrefs"];
  saveKnobPrefs?: ResourceModeCardProps["saveKnobPrefs"];
  /** Backup custody remains on Overview while local footprint lives on Storage. */
  backup?: Omit<BackupCardProps, "now">;
  initialTab?: TabId;
  loadLocalUsage?: StorageScreenProps["loadLocalUsage"];
  saveStorageLimits?: StorageScreenProps["saveStorageLimits"];
  loadOwners?: StorageScreenProps["loadOwners"];
  /** Viewer seats can inspect this gateway but cannot operate its host. */
  readOnly?: boolean;
  focus?: "backups" | "capacity";
  cause?: "backup-alert";
}

type TabId = "overview" | "storage" | "components" | "logs" | "alerts";

const STATUS_WORD: Record<ReconciledStatus, string> = {
  up: "Answering",
  degraded: "Degraded",
  down: "Not answering",
  unknown: "Checking…",
};

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
  const unhealthyCount = health
    ? health.components.filter((c) => c.status !== "ok").length
    : 0;

  const [tab, setTab] = useState<TabId>(props.initialTab ?? "overview");
  const [logsFocus, setLogsFocus] = useState<
    { text: string; nonce: number } | undefined
  >(undefined);
  const jumpNonceRef = useRef(0);
  const jumpToLogs = (component: string): void => {
    jumpNonceRef.current += 1;
    setLogsFocus({ text: component, nonce: jumpNonceRef.current });
    setTab("logs");
  };

  // The gateway's own uptime clock, advanced from the last heartbeat so it
  // ticks between polls. Server-reported, so a desktop/gateway clock skew
  // can't distort it. Keyed off the raw heartbeat, not the reconciled
  // status — a degraded component doesn't blank the uptime figure.
  const uptimeMs =
    heartbeat === "up" &&
    snapshot.gatewayUptimeMs !== undefined &&
    snapshot.lastCheckAt !== undefined
      ? snapshot.gatewayUptimeMs + Math.max(0, now - snapshot.lastCheckAt)
      : undefined;
  const availability = availabilityPct(snapshot);
  // SEAM: the runtime wire carries only this process session's sample ring and
  // outage list. Do not present either as 30-day history. A durable daily
  // availability series must be added to the gateway contract before this
  // overview can draw the handoff's 30-day composition.

  return (
    <div className={styles.page} data-status={overall}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="Cellular" size={16} />
          </span>
          <h1>
            {tab === "overview"
              ? "System"
              : tab === "alerts"
                ? "Alert history"
                : tab[0]?.toUpperCase() + tab.slice(1)}
          </h1>
        </div>
        <div className={styles.headMeta}>
          heartbeat · every {Math.round(snapshot.pollIntervalMs / 1000)}s
          {snapshot.lastCheckAt === undefined
            ? ""
            : ` · checked ${formatAgo(snapshot.lastCheckAt, now)}`}
        </div>
      </div>

      {tab === "overview" ? (
        <nav className={styles.detailLinks} aria-label="System details">
          <button type="button" onClick={() => setTab("components")}>
            Components{unhealthyCount > 0 ? ` · ${unhealthyCount}` : ""}
          </button>
          <button type="button" onClick={() => setTab("logs")}>
            Logs
          </button>
          <button type="button" onClick={() => setTab("alerts")}>
            Alert history
          </button>
        </nav>
      ) : (
        <button
          className={styles.systemBack}
          type="button"
          onClick={() => setTab("overview")}
        >
          ‹ System · Back
        </button>
      )}

      {tab === "overview" ? (
        <>
          {props.cause === "backup-alert" ? (
            <section className={styles.panel} data-testid="system-arrival">
              <div className={styles.panelEmpty}>
                From the backup alert — backups are shown first.
              </div>
            </section>
          ) : null}
          {props.focus === "backups" && props.backup ? (
            <BackupCard {...props.backup} now={now} readOnly={props.readOnly} />
          ) : null}
          {props.focus === "capacity" &&
          props.loadLocalUsage &&
          props.saveStorageLimits ? (
            <StorageScreen
              loadLocalUsage={props.loadLocalUsage}
              saveStorageLimits={props.saveStorageLimits}
              {...(props.loadOwners ? { loadOwners: props.loadOwners } : {})}
              readOnly={props.readOnly}
            />
          ) : null}
          {/* The H5 service offer, relocated here from a blocking onboarding
              step. Demotes itself to a one-line standing control once the
              user declines — dismissing the pitch must not retire the only
              way to install the service — and disappears once installed. */}
          {props.readOnly ? null : <GatewayServiceTip />}

          {props.readOnly ? (
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2>Read-only here</h2>
              </div>
              <div className={styles.panelEmpty}>
                Backup, capacity, component, and alert controls are available in
                Centraid on {snapshot.gatewayLabel}.
              </div>
            </section>
          ) : null}

          {/* Hero — orb + status word on the left, the gauge cluster on the
              right, heartbeat strip across the bottom. */}
          <section className={styles.hero}>
            <div className={styles.heroTop}>
              <div className={styles.statusCluster}>
                <span className={styles.orb} aria-hidden="true">
                  <span className={styles.orbCore} />
                </span>
                <div className={styles.statusText}>
                  <div className={styles.statusWord}>
                    {props.readOnly && snapshot.lastCheckAt !== undefined
                      ? `This browser last synced ${formatAgo(snapshot.lastCheckAt, now)}`
                      : STATUS_WORD[overall]}
                  </div>
                  <div className={styles.statusSub}>
                    {props.readOnly ? (
                      <>Runs on {snapshot.gatewayLabel}</>
                    ) : (
                      <>
                        {snapshot.statusSince === undefined
                          ? ""
                          : `for ${formatDuration(now - snapshot.statusSince)} · `}
                        {snapshot.gatewayKind} gateway “{snapshot.gatewayLabel}”
                      </>
                    )}
                  </div>
                  {heartbeat === "down" && snapshot.lastError ? (
                    <div className={styles.statusError}>
                      {snapshot.lastError}
                    </div>
                  ) : null}
                  {/* The consequence, said out loud at the moment it bites.
                      A local gateway is a child of this app, so "down" also
                      means every other device just lost the vault — most
                      people meet that fact as "my phone can't see my stuff",
                      with nothing connecting it back to here. */}
                  {heartbeat === "down" && snapshot.gatewayKind === "local" ? (
                    <div className={styles.statusSub}>
                      This gateway runs inside Centraid — while it’s down, your
                      phone and other devices can’t reach this vault either.
                    </div>
                  ) : null}
                  {overall === "degraded" ? (
                    <div className={styles.statusDegraded}>
                      {unhealthyCount} component
                      {unhealthyCount === 1 ? "" : "s"} reporting trouble — see
                      Components
                    </div>
                  ) : null}
                </div>
              </div>
              <div className={styles.figures}>
                <Figure
                  label="Gateway uptime"
                  value={uptimeMs === undefined ? "——" : formatUptime(uptimeMs)}
                  {...(snapshot.gatewayStartedAt !== undefined &&
                  uptimeMs !== undefined
                    ? { sub: `since ${formatClock(now - uptimeMs)}` }
                    : {})}
                />
                <Figure
                  label="Latency"
                  value={
                    heartbeat === "up" && snapshot.latencyMs !== undefined
                      ? `${snapshot.latencyMs} ms`
                      : "——"
                  }
                />
                <Figure
                  label="Availability"
                  value={
                    availability === undefined
                      ? "——"
                      : `${availability.toFixed(1)}%`
                  }
                  sub={`${snapshot.checksTotal} checks this session`}
                />
              </div>
            </div>
          </section>

          {/* Two packed columns, not one auto-placed grid: shared grid rows
              let the tall Resource card open a dead column next to it. */}
          <div className={styles.grid}>
            <div className={styles.gridCol}>
              {!props.readOnly &&
              props.loadResourceMode &&
              props.saveResourceMode ? (
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
                  {...(props.onPauseBackgroundWork
                    ? { onPause: props.onPauseBackgroundWork }
                    : {})}
                  {...(props.onResumeBackgroundWork
                    ? { onResume: props.onResumeBackgroundWork }
                    : {})}
                  {...(props.loadKnobPrefs
                    ? { loadKnobPrefs: props.loadKnobPrefs }
                    : {})}
                  {...(props.saveKnobPrefs
                    ? { saveKnobPrefs: props.saveKnobPrefs }
                    : {})}
                />
              ) : null}
            </div>

            <div className={styles.gridCol}>
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
                      {snapshot.version ?? "—"}
                      {snapshot.protocolVersion === undefined
                        ? ""
                        : ` · protocol ${snapshot.protocolVersion}`}
                    </dd>
                  </div>
                  <div className={styles.idRow}>
                    <dt>Started</dt>
                    <dd className={styles.idMono}>
                      {uptimeMs === undefined
                        ? "—"
                        : formatClock(now - uptimeMs)}
                    </dd>
                  </div>
                  <div className={styles.idRow}>
                    <dt>Checks</dt>
                    <dd className={styles.idMono}>
                      {snapshot.checksTotal} run · {snapshot.checksFailed}{" "}
                      failed
                    </dd>
                  </div>
                </dl>
                {props.readOnly ? (
                  <div className={styles.panelEmpty}>
                    Runs on {snapshot.gatewayLabel}.
                  </div>
                ) : props.onRestartGateway ? (
                  <div className={styles.idFooter}>
                    <RestartGatewayButton onRestart={props.onRestartGateway} />
                  </div>
                ) : null}
              </section>
            </div>
          </div>

          {props.focus !== "backups" && props.backup ? (
            <BackupCard {...props.backup} now={now} readOnly={props.readOnly} />
          ) : null}
          {props.focus !== "capacity" &&
          props.loadLocalUsage &&
          props.saveStorageLimits ? (
            <StorageScreen
              loadLocalUsage={props.loadLocalUsage}
              saveStorageLimits={props.saveStorageLimits}
              {...(props.loadOwners ? { loadOwners: props.loadOwners } : {})}
              readOnly={props.readOnly}
            />
          ) : null}
        </>
      ) : null}

      {tab === "components" ? (
        <div className={styles.tabPane}>
          <SettingsDiagnosticsScreen
            loadHealth={props.loadHealth}
            onJumpToLogs={jumpToLogs}
            {...(props.connections
              ? {
                  connections: props.readOnly
                    ? {
                        loadConnections: props.connections.loadConnections,
                        ...(props.connections.refreshKey === undefined
                          ? {}
                          : { refreshKey: props.connections.refreshKey }),
                      }
                    : props.connections,
                }
              : {})}
          />
        </div>
      ) : null}

      {tab === "storage" && props.loadLocalUsage && props.saveStorageLimits ? (
        <div className={styles.tabPane}>
          <StorageScreen
            loadLocalUsage={props.loadLocalUsage}
            saveStorageLimits={props.saveStorageLimits}
            {...(props.loadOwners ? { loadOwners: props.loadOwners } : {})}
            readOnly={props.readOnly}
          />
        </div>
      ) : null}

      {tab === "logs" ? (
        <div className={styles.tabPane}>
          <LogsScreen
            streamLogs={props.streamLogs}
            focusQuery={logsFocus}
            {...(!props.readOnly && props.onExportDiagnostics
              ? { onExportDiagnostics: props.onExportDiagnostics }
              : {})}
          />
        </div>
      ) : null}

      {tab === "alerts" ? (
        <GatewayAlertsTab
          snapshot={snapshot}
          readOnly={props.readOnly}
          savingAlert={props.savingAlert}
          {...(props.onAlertSecondsChange
            ? { onAlertSecondsChange: props.onAlertSecondsChange }
            : {})}
          {...(props.onAlertsEnabledChange
            ? { onAlertsEnabledChange: props.onAlertsEnabledChange }
            : {})}
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
