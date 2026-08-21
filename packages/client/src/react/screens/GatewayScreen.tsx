// governance: allow-repo-hygiene file-size-limit one instrument-panel screen
// (runtime + backup + storage + components + logs + alerts) threading bridge
// props to each drill-in's own screen component — binding layer v11 traded the
// tab strip for one scrolling overview, which moved the drill-in links into the
// body without shortening the prop wiring.
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

/*
 * System — gateway runtime, backup custody, capacity, resource mode, and the
 * three drill-ins (#341/#344/#347/#608; binding layer v11).
 *
 * ONE SCROLLING OVERVIEW, NO TAB STRIP. The tabs were page-level navigation
 * dressed as a filter: they put Components, Logs and Alert history in front of
 * a member who arrived because a backup was overdue, and they hid Capacity
 * behind a word. In v11 the page reads top to bottom in the order the
 * questions are asked — is it answering, what is wrong now, are there copies,
 * is there room, how hard is it working, what is it — and the three diagnostic
 * pages are LINKS at the foot, under "Look closer". A drill-in is a page, so it
 * carries its own way back: System is never pinned in the band, and without
 * that row there is no route home at all.
 *
 * Green sections are absent, not empty: "What's wrong now" does not exist when
 * nothing is.
 *
 * People & devices remain on Household (#599), where their ownership context is
 * visible; the alert history stays here rather than on Notifications, because
 * durable machine health is System's subject.
 */

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
  /** Polled component-health summary — reconciles the Overview status and
   *  names the rows under "What's wrong now". `null` before the first poll. */
  health: GatewayHealthDTO | null;
  loadHealth: SettingsDiagnosticsBridgeProps["loadHealth"];
  /** Host plumbing for the Components drill-in's Connections section (#665).
   *  Optional so hosts with no gateway registry (and route tests) still render. */
  connections?: DiagnosticsConnectionsProps;
  streamLogs: LogsBridgeProps["streamLogs"];
  /**
   * Restart the local embedded gateway (Identity section). Refused for a
   * remote gateway — main answers `{ok: false}` with an explanation, rendered
   * inline rather than thrown.
   */
  onRestartGateway?: () => Promise<{ ok: boolean; error?: string }>;
  /** Save `/centraid/_gateway/diagnostics` through a native dialog (Logs
   *  drill-in toolbar). `canceled` when the user dismissed the dialog. */
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
  /** Backup custody sits above capacity — the copies question comes first. */
  backup?: Omit<BackupCardProps, "now">;
  initialTab?: TabId;
  /**
   * Open one of System's pages AS A ROUTE, so the frame's back arrow returns
   * to the overview and a drill-in can be deep-linked.
   *
   * Absent, the screen keeps the page in local state and behaves exactly as it
   * did — which is what a test rendering it standalone, or a host with no
   * router, needs. The one thing it must never do is draw its own back
   * control: that was a second, competing way back sitting inside the page.
   */
  onOpenTab?: (tab: TabId) => void;
  loadLocalUsage?: StorageScreenProps["loadLocalUsage"];
  saveStorageLimits?: StorageScreenProps["saveStorageLimits"];
  loadOwners?: StorageScreenProps["loadOwners"];
  /** Viewer seats can inspect this gateway but cannot operate its host. */
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

/** The drill-in's own title — what the app bar says while you are on it. The
 *  way BACK is the frame's, not the page's. */
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
  // Routed when the host gave us a way to navigate — the route is then the one
  // source of truth for which page is showing, and the frame owns the way back.
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
  // The heartbeat strip — the handoff's picture of availability, drawn from
  // the window we actually measured. SEAM: `samples` is a per-launch ring, so
  // the strip names THIS SESSION in its axis, its note and its aria sentence
  // rather than the handoff's thirty days; a durable daily series has to reach
  // the gateway contract before the month can be drawn honestly. See
  // `gatewayHeartbeat.ts` for why the columns are probes and not minutes.
  const strip = buildHeartbeatStrip(snapshot.samples, now);

  // ── The hero, WHEN THERE IS SOMETHING TO EXPLAIN.
  //
  // It used to open the page in every state, and once the strip and the status
  // line's own stamp landed it was saying nothing the rest of the page had not
  // already said better: "This browser last synced 4s ago" over a foot that
  // reads "Synced · 4s ago" and an app bar that reads "checked just now";
  // "availability 100.0%" over a strip whose entire subject is availability;
  // "uptime 3h 31m" over an Identity row stating when the gateway started. A
  // panel restating its own page is furniture, and a bordered one at the top of
  // the first screenful is expensive furniture.
  //
  // A gateway that is NOT ANSWERING is the exception, and the reason to keep
  // the block at all: that state needs a paragraph, not a row — what stopped,
  // what did not, and what it means for the other devices — and the page's
  // subject really is the outage. Degraded stays absent: "What's wrong now"
  // already names the component and offers the page that can act on it, which
  // is more than a paragraph could.
  const heroTitle =
    snapshot.statusSince === undefined
      ? STATUS_WORD.down
      : `Not answering since ${formatClock(snapshot.statusSince)}`;
  // The consequence, said out loud at the moment it bites. A local gateway is
  // a child of this app, so "down" also means every other device just lost the
  // vault — most people meet that fact as "my phone can't see my stuff", with
  // nothing connecting it back to here.
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

  // ── What's wrong now. One row per thing, each carrying the way to the page
  // that can do something about it. Absent entirely when nothing is wrong.
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

  // ── Identity. Architecture nouns are allowed here and nowhere else.
  const identity: RowDef[] = [
    {
      id: "machine",
      // UPTIME LIVES HERE NOW, ticking, rather than in a hero fact list: this
      // is the row about the machine, and how long it has been up is a fact
      // about the machine.
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
      // AVAILABILITY AND LATENCY LAND HERE, for the same reason: they are facts
      // about the probing, and this is the probing's row. The strip above draws
      // the shape; this states the two numbers the shape cannot.
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
    // A PAGE, not a button. Twenty seconds with the vault out of reach of
    // every device is a consequence that belongs in front of the member before
    // the act, not in a tooltip after it.
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

  // ── Look closer. Pages, linked — not tabs. Storage is absent on purpose:
  // capacity is already on this page, and its route id survives only so old
  // deep links land somewhere.
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

      {/* NO BACK ROW. A drill-in used to open its own "‹ System · Back" row at
          the top of the page — a second back control, three inches below the
          frame's own back arrow and pointing at the same place. The drill-ins
          are routes now (`onOpenTab`), so the arrow in the chrome already
          returns to the overview and the page keeps its first screenful for
          what it is actually about. */}

      {tab === "overview" ? (
        <>
          {/* ONLY WHEN IT IS NOT ANSWERING (see `heroTitle` above). No eyebrow
              either: the badge over the title was a third statement of what the
              `<h1>` and the body already say. */}
          {overall === "down" ? (
            <PanelBlock
              body={heroBody}
              facts={heroFacts}
              title={heroTitle}
              tone="net"
              wide
            />
          ) : null}

          {/* Availability as a shape rather than a percentage: a percentage
              cannot say WHEN it stopped, and that is the question people
              arrive with. Absent until three probes have landed — below that
              the strip is two rectangles rather than a shape. */}
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

          {/* Pre-focused arrival: the cause is named, and the section it
              belongs to is the next thing on the page rather than something to
              go looking for. */}
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

          {/* The H5 service offer, relocated here from a blocking onboarding
              step. Demotes itself to a one-line standing control once the user
              declines — dismissing the pitch must not retire the only way to
              install the service — and disappears once installed. */}
          {props.readOnly ? null : <GatewayServiceTip />}

          {/* Custody before capacity, unless the member arrived asking about
              room. Each card owns its own section head. */}
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

          {/* NO CLOSING NOTE. It was two paragraphs of commentary ABOUT the
              page — one explaining that this seat withholds verbs, one
              explaining that System is never pinned in the band. Neither is a
              fact about the gateway, and the first was doing real work in the
              wrong place: a row whose verb is withheld should say so ON THE
              ROW, where the reader is already looking, which is what the
              Identity row and the read-only rows now do. */}
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
