import { BrowserWindow, Notification } from "electron";

import { setTrayGatewayRunning } from "./app-chrome.js";
import {
  applyComponentAlerts,
  applyProbe,
  applyVersionSkewAlert,
  DEFAULT_ALERT_SECONDS,
  DEFAULT_COMPONENT_ALERT_SECONDS,
  evaluateAlert,
  formatDurationMs,
  initialRuntimeState,
  isPendingBootProbe,
} from "./gateway-monitor-core.js";
import type {
  GatewayAlertAction,
  GatewayAlertConfig,
  GatewayComponentAlertAction,
  GatewayProbe,
  GatewayRuntimeState,
  GatewayVersionSkewAction,
} from "./gateway-monitor-core.js";
import { probeGateway } from "./gateway-monitor-probe.js";
import { deriveOutageEvents } from "./gateway-outage-log-core.js";
import type { OutageLogEvent } from "./gateway-outage-log-core.js";
import { loadOutageLog, persistOutageEvents } from "./gateway-outage-log.js";
import {
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
} from "./gateway-supervisor-core.js";
import {
  getLocalGatewaySupervisorState,
  reviveLocalGatewayIfDead,
} from "./local-gateway.js";
import { pushPowerContext } from "./power-context-push.js";
import { loadSettings } from "./settings.js";

export const GATEWAY_RUNTIME_POLL_MS = 5000;
const RUNTIME_EVENT_CHANNEL = "centraid:gateway-runtime:event";

export interface OutageLogSnapshotEntry extends Omit<
  OutageLogEvent,
  "gatewayId" | "gatewayLabel"
> {
  previousSession: boolean;
}

export interface GatewayRuntimeSnapshot extends Omit<
  GatewayRuntimeState,
  "componentAlerts" | "versionSkewAlertedAt"
> {
  alert: GatewayAlertConfig;
  pollIntervalMs: number;
  alertHistory: OutageLogSnapshotEntry[];
}

let state: GatewayRuntimeState | undefined;
let lastSnapshot: GatewayRuntimeSnapshot | undefined;
let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;
const crashLoopNotified = new Set<string>();
let outageHistory: OutageLogEvent[] | undefined;
let historyBootAt: number | undefined;

function notify(action: GatewayAlertAction, label: string): void {
  if (!Notification.isSupported()) return;
  const n =
    action.kind === "down"
      ? new Notification({
          title: "Gateway unreachable",
          body: `Centraid has not reached “${label}” for ${formatDurationMs(action.downForMs)}.`,
          urgency: "critical",
        })
      : new Notification({
          title: "Gateway back online",
          body: `“${label}” recovered after ${formatDurationMs(action.outageMs)}.`,
        });
  n.show();
}

function notifyComponent(
  action: GatewayComponentAlertAction,
  gatewayLabel: string
): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: "Gateway component unhealthy",
    body:
      `“${action.component}” on “${gatewayLabel}” has been erroring for ` +
      `${formatDurationMs(action.downForMs)}${action.message ? `: ${action.message}` : "."}`,
    urgency: "critical",
  });
  n.show();
}

function notifyVersionSkew(
  action: GatewayVersionSkewAction,
  gatewayLabel: string
): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: "Gateway version mismatch",
    body:
      `“${gatewayLabel}” runs v${action.gatewayVersion} (protocol ` +
      `${action.gatewayProtocolVersion}), not what this app expects — update both ` +
      "to the same version.",
    urgency: "critical",
  });
  n.show();
}

function notifyCrashLoop(
  gatewayLabel: string,
  lastError: string | undefined
): void {
  if (!Notification.isSupported()) return;
  const windowMinutes = Math.round(CRASH_LOOP_WINDOW_MS / 60_000);
  const n = new Notification({
    title: "Gateway failed repeatedly",
    body:
      `“${gatewayLabel}” failed to start ${CRASH_LOOP_THRESHOLD}+ times in the last ` +
      `${windowMinutes} minutes — Centraid stopped retrying automatically.` +
      (lastError ? ` Last error: ${lastError}.` : "") +
      " Use Settings → Gateway to restart it manually.",
    urgency: "critical",
  });
  n.show();
}

function broadcast(snapshot: GatewayRuntimeSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(RUNTIME_EVENT_CHANNEL, snapshot);
  }
}

async function tick(): Promise<void> {
  let settings: Awaited<ReturnType<typeof loadSettings>> | undefined;
  let settingsError: string | undefined;
  try {
    settings = await loadSettings();
  } catch (error) {
    settingsError = error instanceof Error ? error.message : String(error);
    if (!state) {
      process.stdout.write(
        `[gateway-monitor] settings unavailable, no prior state to track: ${settingsError}\n`
      );
      return;
    }
  }

  if (settings) {
    if (!state || state.gatewayId !== settings.activeGatewayId) {
      state = initialRuntimeState(
        {
          id: settings.activeGatewayId,
          label: settings.activeGatewayLabel,
          kind: settings.activeGatewayKind,
        },
        Date.now()
      );
    }
    state = {
      ...state,
      gatewayLabel: settings.activeGatewayLabel,
      gatewayKind: settings.activeGatewayKind,
    };
  }
  const trackedState = state as GatewayRuntimeState;

  const activeGatewayKind =
    settings?.activeGatewayKind ?? trackedState.gatewayKind;
  const localSupervisor =
    activeGatewayKind === "local"
      ? getLocalGatewaySupervisorState(trackedState.gatewayId)
      : undefined;
  const probe: GatewayProbe = settings
    ? localSupervisor?.loopBroken
      ? {
          at: Date.now(),
          ok: false,
          detail:
            localSupervisor.lastError ?? "local gateway failed repeatedly",
        }
      : settings.gatewayUrl
        ? await probeGateway(settings.gatewayUrl, settings.gatewayToken)
        : {
            at: Date.now(),
            ok: false,
            detail: "gateway URL not resolved yet",
            bootPhase: true,
          }
    : {
        at: Date.now(),
        ok: false,
        detail: settingsError ?? "settings unavailable",
        bootPhase: true,
      };
  if (!probe.ok && activeGatewayKind === "local") {
    await reviveLocalGatewayIfDead(trackedState.gatewayId);
  }
  if (settings?.gatewayUrl) {
    void pushPowerContext(settings.gatewayUrl, settings.gatewayToken);
  }

  const prevStatus = trackedState.status;
  const prevHealthStatus = trackedState.healthStatus;
  state = isPendingBootProbe(trackedState, probe)
    ? trackedState
    : applyProbe(trackedState, probe);

  const inFirstRunSetup =
    settings !== undefined && settings.onboardingCompletedAt === undefined;
  const alert: GatewayAlertConfig = {
    enabled: (settings?.gatewayAlertsEnabled ?? true) && !inFirstRunSetup,
    thresholdSeconds: settings?.gatewayAlertSeconds ?? DEFAULT_ALERT_SECONDS,
  };
  const evaluated = evaluateAlert(state, alert, Date.now());
  state = evaluated.state;
  if (evaluated.action) notify(evaluated.action, state.gatewayLabel);

  const componentAlert: GatewayAlertConfig = {
    enabled: alert.enabled,
    thresholdSeconds: DEFAULT_COMPONENT_ALERT_SECONDS,
  };
  const componentEvaluated = applyComponentAlerts(
    state,
    Date.now(),
    componentAlert
  );
  state = componentEvaluated.state;
  for (const action of componentEvaluated.actions)
    notifyComponent(action, state.gatewayLabel);

  const skewEvaluated = applyVersionSkewAlert(state, alert, Date.now());
  state = skewEvaluated.state;
  if (skewEvaluated.action)
    notifyVersionSkew(skewEvaluated.action, state.gatewayLabel);

  if (localSupervisor?.loopBroken) {
    if (!crashLoopNotified.has(state.gatewayId)) {
      crashLoopNotified.add(state.gatewayId);
      notifyCrashLoop(state.gatewayLabel, localSupervisor.lastError);
    }
  } else {
    crashLoopNotified.delete(state.gatewayId);
  }

  if (outageHistory === undefined) {
    outageHistory = loadOutageLog();
    historyBootAt = Date.now();
  }
  const newOutageEvents = deriveOutageEvents({
    prevStatus,
    prevHealthStatus,
    state,
    componentActions: componentEvaluated.actions,
    ...(skewEvaluated.action
      ? { versionSkewAction: skewEvaluated.action }
      : {}),
    now: Date.now(),
  });
  outageHistory = persistOutageEvents(outageHistory, newOutageEvents);

  const {
    componentAlerts: _componentAlerts,
    versionSkewAlertedAt: _skewAlertedAt,
    ...publicState
  } = state;
  const alertHistory: OutageLogSnapshotEntry[] = outageHistory.map((e) => ({
    at: e.at,
    kind: e.kind,
    ...(e.detail === undefined ? {} : { detail: e.detail }),
    ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
    previousSession: historyBootAt !== undefined && e.at < historyBootAt,
  }));
  lastSnapshot = {
    ...publicState,
    alert,
    pollIntervalMs: GATEWAY_RUNTIME_POLL_MS,
    alertHistory,
  };
  broadcast(lastSnapshot);
  setTrayGatewayRunning(state.status === "up");
}

function runTick(): Promise<void> {
  if (!inFlight) {
    inFlight = tick()
      .catch((error) => {
        process.stdout.write(
          `[gateway-monitor] tick failed: ${String(error)}\n`
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}

export function startGatewayMonitor(): void {
  if (timer) return;
  timer = setInterval(() => void runTick(), GATEWAY_RUNTIME_POLL_MS);
  timer.unref?.();
  void runTick();
}

export function stopGatewayMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function getGatewayRuntimeSnapshot(): Promise<GatewayRuntimeSnapshot> {
  if (!lastSnapshot) await runTick();
  if (!lastSnapshot) throw new Error("gateway monitor produced no snapshot");
  return lastSnapshot;
}

export function nudgeGatewayMonitor(): void {
  void runTick();
}
