// governance: allow-repo-hygiene file-size-limit one instrument-panel screen
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
import BarsBlock from "../ui/BarsBlock.js";
import Icon from "../ui/Icon.js";
import PanelBlock from "../ui/PanelBlock.js";
import type { PanelFact } from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import BackupCard from "./BackupCard.js";
import type { BackupCardProps } from "./BackupCard.js";
import GatewayAlertsTab from "./GatewayAlertsTab.js";
import { buildHeartbeatStrip } from "./gatewayHeartbeat.js";
import GatewayServiceTip from "./GatewayServiceTip.js";
import LogsScreen from "./LogsScreen.js";
import type { LogsBridgeProps } from "./LogsScreen.js";
import ResourceModeCard from "./ResourceModeCard.js";
import type {
  ResourceMode,
  ResourceModeCardProps,
} from "./ResourceModeCard.js";
import RestartGatewayScreen from "./RestartGatewayScreen.js";
import SettingsDiagnosticsScreen, {
  componentLabel,
} from "./SettingsDiagnosticsScreen.js";
import type {
  DiagnosticsConnectionsProps,
  GatewayHealthDTO,
  SettingsDiagnosticsBridgeProps,
} from "./SettingsDiagnosticsScreen.js";
import StorageScreen from "./StorageScreen.js";
import type { StorageScreenProps } from "./StorageScreen.js";

import styles from "./GatewayScreen.module.css";

export interface GatewayScreenProps {
  snapshot: GatewayRuntimeSnapshot;
  now: number;
  savingAlert?: boolean;
  onAlertSecondsChange?: (seconds: number) => void;
  onAlertsEnabledChange?: (enabled: boolean) => void;
  launchAtLogin?: boolean;
  onLaunchAtLoginChange?: (enabled: boolean) => void;
  savingLaunchAtLogin?: boolean;
  health: GatewayHealthDTO | null;
  loadHealth: SettingsDiagnosticsBridgeProps["loadHealth"];
  connections?: DiagnosticsConnectionsProps;
  streamLogs: LogsBridgeProps["streamLogs"];
  onRestartGateway?: () => Promise<{ ok: boolean; error?: string }>;
  onExportDiagnostics: LogsBridgeProps["onExportDiagnostics"];
  loadResourceMode?: () => Promise<ResourceMode>;
  saveResourceMode?: (mode: ResourceMode) => Promise<void>;
  onPauseBackgroundWork?: (
    durationMs?: number
  ) => Promise<{ paused: boolean; until: string | null }>;
  onResumeBackgroundWork?: () => Promise<{ paused: boolean }>;
  loadKnobPrefs?: ResourceModeCardProps["loadKnobPrefs"];
  saveKnobPrefs?: ResourceModeCardProps["saveKnobPrefs"];
  backup?: Omit<BackupCardProps, "now">;
  initialTab?: TabId;
  onOpenTab?: (tab: TabId) => void;
  loadLocalUsage?: StorageScreenProps["loadLocalUsage"];
  saveStorageLimits?: StorageScreenProps["saveStorageLimits"];
  loadOwners?: StorageScreenProps["loadOwners"];
  readOnly?: boolean;
  focus?: "backups" | "capacity";
  cause?: "backup-alert";
}

type TabId =
  | "overview"
  | "storage"
  | "components"
  | "logs"
  | "alerts"
  | "restart";
type DrillId = Exclude<TabId, "overview">;

const STATUS_WORD: Record<ReconciledStatus, string> = {
  up: "Answering",
  degraded: "Degraded",
  down: "Not answering",
  unknown: "Checking…",
};

const DRILL: Record<DrillId, string> = {
  alerts: "Alert history",
  components: "Components",
  logs: "Logs",
  restart: "Restart the gateway",
  storage: "Storage",
};

export default function GatewayScreen(props: GatewayScreenProps): JSX.Element {
  const { snapshot, now, health } = props;
  const heartbeat = snapshot.status;
  const overall = reconcileStatus(heartbeat, health);
  const unhealthy = health
    ? health.components.filter((c) => c.status !== "ok")
    : [];

  const [localTab, setLocalTab] = useState<TabId>(
    props.initialTab ?? "overview"
  );
  const routed = props.onOpenTab !== undefined;
  const tab = routed ? (props.initialTab ?? "overview") : localTab;
  const setTab = (next: TabId): void => {
    if (props.onOpenTab) props.onOpenTab(next);
    else setLocalTab(next);
  };
  const [logsFocus, setLogsFocus] = useState<
    { text: string; nonce: number } | undefined
  >(undefined);
  const jumpNonceRef = useRef(0);
  const jumpToLogs = (component: string): void => {
    jumpNonceRef.current += 1;
    setLogsFocus({ text: component, nonce: jumpNonceRef.current });
    setTab("logs");
  };
  const drill: DrillId | null = tab === "overview" ? null : tab;

  const uptimeMs =
    heartbeat === "up" &&
    snapshot.gatewayUptimeMs !== undefined &&
    snapshot.lastCheckAt !== undefined
      ? snapshot.gatewayUptimeMs + Math.max(0, now - snapshot.lastCheckAt)
      : undefined;
  const availability = availabilityPct(snapshot);
  const strip = buildHeartbeatStrip(snapshot.samples, now);

  const heroTitle =
    snapshot.statusSince === undefined
      ? STATUS_WORD.down
      : `Not answering since ${formatClock(snapshot.statusSince)}`;
  const heroBody = props.readOnly
    ? `Runs on ${snapshot.gatewayLabel}, and this browser cannot reach it. What the rest of this page shows is the last replica that machine sent.`
    : snapshot.gatewayKind === "local"
      ? "The bytes are on this machine's disk; what stopped is the daemon that reads them, so other devices cannot reach it."
      : "The bytes are on the machine's disk; what is unreachable is the daemon that reads them, a smaller problem.";

  const heroFacts: PanelFact[] = [
    {
      key: "uptime",
      mono: true,
      value: uptimeMs === undefined ? "——" : formatUptime(uptimeMs),
    },
    {
      key: "latency",
      mono: true,
      value:
        heartbeat === "up" && snapshot.latencyMs !== undefined
          ? `${snapshot.latencyMs} ms`
          : "——",
    },
    {
      key: "availability",
      mono: true,
      note: `${snapshot.checksTotal} checks this session`,
      value: availability === undefined ? "——" : `${availability.toFixed(1)}%`,
    },
  ];
  if (snapshot.statusSince !== undefined && !props.readOnly) {
    heroFacts.push({
      key: "in this state",
      mono: true,
      value: formatDuration(now - snapshot.statusSince),
    });
  }
  if (heartbeat === "down" && snapshot.lastError) {
    heroFacts.push({
      key: "last error",
      mono: true,
      net: true,
      value: snapshot.lastError,
    });
  }

  const openComponents = (): void => setTab("components");
  const trouble: RowDef[] = [];
  if (overall === "down") {
    trouble.push({
      id: "gateway-down",
      meta: "ongoing",
      net: true,
      sub:
        snapshot.statusSince === undefined
          ? "the machine may be asleep, or the daemon may have stopped"
          : `since ${formatClock(snapshot.statusSince)} · the machine may be asleep, or the daemon may have stopped`,
      title: "The gateway is not answering",
      ...(props.readOnly
        ? {}
        : { action: { label: "Components", onClick: openComponents } }),
    });
  }
  for (const component of unhealthy) {
    trouble.push({
      id: `unhealthy-${component.component}`,
      meta: component.status,
      net: true,
      sub:
        component.lastError ??
        component.detail ??
        `${component.errorCount} error${component.errorCount === 1 ? "" : "s"} since it last answered`,
      title: componentLabel(component.component),
      ...(props.readOnly
        ? {}
        : { action: { label: "Components", onClick: openComponents } }),
    });
  }

  const identity: RowDef[] = [
    {
      id: "machine",
      meta: uptimeMs === undefined ? "gateway" : `up ${formatUptime(uptimeMs)}`,
      sub:
        uptimeMs === undefined
          ? `${snapshot.gatewayKind} gateway`
          : `${snapshot.gatewayKind} gateway · started ${formatClock(now - uptimeMs)}`,
      title: snapshot.gatewayLabel,
    },
    {
      id: "version",
      meta: snapshot.version ?? "—",
      sub:
        snapshot.protocolVersion === undefined
          ? "the build this gateway is running"
          : `protocol ${snapshot.protocolVersion}`,
      title: "Version",
    },
    {
      id: "checks",
      meta:
        availability === undefined
          ? "this session"
          : `${availability.toFixed(1)}% this session`,
      sub: [
        `${snapshot.checksTotal.toLocaleString()} run`,
        `${snapshot.checksFailed.toLocaleString()} failed`,
        heartbeat === "up" && snapshot.latencyMs !== undefined
          ? `${snapshot.latencyMs} ms last round trip`
          : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      title: "Heartbeats",
    },
  ];
  if (props.readOnly) {
    identity.push({
      id: "restart",
      meta: "read-only",
      sub: "restarting the gateway is done on that machine",
      title: `Runs on ${snapshot.gatewayLabel}`,
    });
  } else if (props.onRestartGateway) {
    identity.push({
      action: {
        hint: "Read what a restart does, then decide",
        label: "Restart",
        onClick: () => setTab("restart"),
      },
      id: "restart",
      sub: "apps reconnect on their own · nothing is written during a restart",
      title: "Restart the gateway",
    });
  }

  const lookCloser: RowDef[] = [
    {
      action: {
        hint: "Open Components",
        label: "Open",
        onClick: openComponents,
      },
      id: "components",
      meta:
        unhealthy.length > 0
          ? `${unhealthy.length} in trouble`
          : health
            ? `${health.components.length} answering`
            : "not read yet",
      net: unhealthy.length > 0,
      sub: "every subsystem, whether it is answering, and what to do if it is not",
      title: "Components",
    },
    {
      action: {
        hint: "Open Logs",
        label: "Open",
        onClick: () => setTab("logs"),
      },
      id: "logs",
      sub: "the stream, with a focus query · export diagnostics from here",
      title: "Logs",
    },
    {
      action: {
        hint: "Open Alert history",
        label: "Open",
        onClick: () => setTab("alerts"),
      },
      id: "alerts",
      sub: "every alert this gateway has raised, and what cleared it",
      title: "Alert history",
    },
  ];

  const capacity =
    props.loadLocalUsage && props.saveStorageLimits ? (
      <StorageScreen
        loadLocalUsage={props.loadLocalUsage}
        saveStorageLimits={props.saveStorageLimits}
        {...(props.loadOwners ? { loadOwners: props.loadOwners } : {})}
        gatewayLabel={snapshot.gatewayLabel}
        readOnly={props.readOnly}
      />
    ) : null;
  const backups = props.backup ? (
    <BackupCard {...props.backup} now={now} readOnly={props.readOnly} />
  ) : null;

  return (
    <div className={styles.page} data-status={overall}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="Cellular" size={16} />
          </span>
          <h1>{drill ? DRILL[drill] : "System"}</h1>
        </div>
        <div className={styles.headMeta}>
          heartbeat · every {Math.round(snapshot.pollIntervalMs / 1000)}s
          {snapshot.lastCheckAt === undefined
            ? ""
            : ` · checked ${formatAgo(snapshot.lastCheckAt, now)}`}
        </div>
      </div>

      {/* NO BACK ROW: the chrome's arrow already returns to the overview. */}

      {tab === "overview" ? (
        <>
          {/* Only when not answering (see `heroTitle`); no eyebrow either. */}
          {overall === "down" ? (
            <PanelBlock
              body={heroBody}
              facts={heroFacts}
              title={heroTitle}
              tone="net"
              wide
            />
          ) : null}

          {/* A shape, not a percentage: only a shape says WHEN it stopped. */}
          {strip ? (
            <div data-testid="heartbeat-strip">
              <BarsBlock
                ariaLabel={strip.ariaLabel}
                axis={strip.axis}
                bars={strip.bars}
                legend={strip.legend}
                note={strip.note}
                partial={strip.partial}
              />
            </div>
          ) : null}

          {/* Pre-focused arrival. */}
          {props.cause === "backup-alert" ? (
            <div data-testid="system-arrival">
              <RowsBlock
                ariaLabel="Why you are here"
                rows={[
                  {
                    id: "arrival",
                    meta: "why you are here",
                    sub: "backups are shown first · nothing else has been touched",
                    title: "You arrived from the backup alert",
                  },
                ]}
              />
            </div>
          ) : null}

          {trouble.length > 0 ? (
            <div>
              <SectionBlock
                label="What’s wrong now"
                meta={String(trouble.length)}
              />
              <RowsBlock ariaLabel="What’s wrong now" rows={trouble} />
            </div>
          ) : null}

          {/* Declining demotes the pitch; never retire the install path. */}
          {props.readOnly ? null : <GatewayServiceTip />}

          {/* Custody before capacity unless they arrived asking about room. */}
          {props.focus === "capacity" ? (
            <>
              {capacity}
              {backups}
            </>
          ) : (
            <>
              {backups}
              {capacity}
            </>
          )}

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

          <div>
            <SectionBlock label="Identity" meta="this machine" />
            <RowsBlock ariaLabel="Identity" rows={identity} />
          </div>

          <div>
            <SectionBlock label="Look closer" meta="3 pages" />
            <RowsBlock ariaLabel="Look closer" rows={lookCloser} />
          </div>

          {/* NO CLOSING NOTE: a withheld verb says so on its own row. */}
        </>
      ) : null}

      {tab === "components" ? (
        <div className={styles.tabPane}>
          <SettingsDiagnosticsScreen
            loadHealth={props.loadHealth}
            onJumpToLogs={jumpToLogs}
            onOpenAlerts={() => setTab("alerts")}
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

      {tab === "storage" && capacity ? (
        <div className={styles.tabPane}>{capacity}</div>
      ) : null}

      {tab === "restart" && props.onRestartGateway ? (
        <div className={styles.tabPane}>
          <RestartGatewayScreen
            gatewayLabel={snapshot.gatewayLabel}
            onCancel={() => setTab("overview")}
            onRestart={props.onRestartGateway}
            {...(uptimeMs === undefined ? {} : { uptimeMs })}
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
