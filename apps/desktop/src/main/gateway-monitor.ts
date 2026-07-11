/*
 * Gateway runtime monitor (main process).
 *
 * The desktop had no live "is the gateway up" signal at all — the renderer
 * only ever learned about an unreachable gateway when a data request failed.
 * This module owns the heartbeat: every {@link GATEWAY_RUNTIME_POLL_MS} it
 * probes the active gateway's `/centraid/_gateway/health` — component-level
 * status, not just "a compatible gateway is listening" (falling back to the
 * plain `/centraid/_gateway/info` liveness probe for older gateways that
 * 404 on `/health`) — folds the result through the pure core
 * (gateway-monitor-core.ts), broadcasts the snapshot to every window, and
 * fires OS notifications: the existing whole-gateway down/recovered pair
 * (settings-backed threshold, default 2 minutes), a new per-component
 * "this subsystem has been erroring" alert (de-duped, issue #351), and a
 * "gateway failed repeatedly" alert when the embedded local gateway's
 * supervised auto-restart (local-gateway.ts) gives up.
 *
 * It lives in main, not the renderer, so the watch survives navigation and
 * alerts land even when the window is backgrounded. State is in-memory and
 * per-launch; switching the active gateway resets tracking (the history
 * belongs to the gateway it was recorded against).
 */

import { BrowserWindow, Notification } from 'electron';
import { loadSettings } from './settings.js';
import { getLocalGatewaySupervisorState } from './local-gateway.js';
import { CRASH_LOOP_THRESHOLD, CRASH_LOOP_WINDOW_MS } from './gateway-supervisor-core.js';
import {
  applyComponentAlerts,
  applyProbe,
  DEFAULT_ALERT_SECONDS,
  DEFAULT_COMPONENT_ALERT_SECONDS,
  evaluateAlert,
  formatDurationMs,
  initialRuntimeState,
  type GatewayAlertAction,
  type GatewayAlertConfig,
  type GatewayComponentAlertAction,
  type GatewayComponentIssue,
  type GatewayProbe,
  type GatewayRuntimeState,
} from './gateway-monitor-core.js';

export const GATEWAY_RUNTIME_POLL_MS = 5000;
/** A hung probe counts as down well before the next tick would queue up. */
const PROBE_TIMEOUT_MS = 4000;
/** Broadcast channel — keep in sync with `Channel` in ipc.ts + preload.ts. */
const RUNTIME_EVENT_CHANNEL = 'centraid:gateway-runtime:event';
const HEALTH_PATH = '/centraid/_gateway/health';
const INFO_PATH = '/centraid/_gateway/info';

/**
 * The wire snapshot the renderer's Gateway page renders. `componentAlerts`
 * is internal alert-dedupe bookkeeping (mirrors the outage log's
 * `alertedAt`) — deliberately NOT part of the broadcast payload, so it's
 * omitted here rather than inherited from `GatewayRuntimeState`.
 */
export interface GatewayRuntimeSnapshot extends Omit<GatewayRuntimeState, 'componentAlerts'> {
  alert: GatewayAlertConfig;
  pollIntervalMs: number;
}

let state: GatewayRuntimeState | undefined;
let lastSnapshot: GatewayRuntimeSnapshot | undefined;
let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;
/** De-dupes the crash-loop OS notification — one per loop-broken episode. */
const crashLoopNotified = new Set<string>();

/** Plain liveness probe — used as the primary probe on a `/health` 404 (older gateway). */
async function probeInfo(baseUrl: string, token: string | undefined): Promise<GatewayProbe> {
  const startedAt = Date.now();
  try {
    const res = await fetch(new URL(INFO_PATH, `${baseUrl}/`).toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const at = Date.now();
    if (!res.ok) return { at, ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      at,
      ok: true,
      latencyMs: at - startedAt,
      ...(typeof body.startedAt === 'number' ? { gatewayStartedAt: body.startedAt } : {}),
      ...(typeof body.uptimeMs === 'number' ? { gatewayUptimeMs: body.uptimeMs } : {}),
      ...(typeof body.version === 'string' ? { version: body.version } : {}),
      ...(typeof body.schemaEpoch === 'number' ? { schemaEpoch: body.schemaEpoch } : {}),
    };
  } catch (err) {
    return {
      at: Date.now(),
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Pull the non-'ok' components out of a `/health` payload's `components` array. */
function extractComponentIssues(body: Record<string, unknown>): GatewayComponentIssue[] {
  const raw = Array.isArray(body.components) ? body.components : [];
  const issues: GatewayComponentIssue[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    if (rec.status !== 'degraded' && rec.status !== 'error') continue;
    if (typeof rec.component !== 'string') continue;
    const message =
      typeof rec.lastError === 'string'
        ? rec.lastError
        : typeof rec.detail === 'string'
          ? rec.detail
          : undefined;
    issues.push({ component: rec.component, status: rec.status, ...(message ? { message } : {}) });
  }
  return issues;
}

/**
 * Heartbeat probe: `/centraid/_gateway/health` (component-level status — a
 * hung-but-listening gateway shows up here, not just "is a compatible
 * gateway listening"), falling back to the plain `/info` liveness probe on
 * a 404 (a gateway built before #347/#351 that doesn't expose `/health`
 * yet). `healthStatus`/`componentIssues` simply stay unpopulated for a
 * gateway served via the fallback.
 */
async function probeGateway(baseUrl: string, token: string | undefined): Promise<GatewayProbe> {
  const startedAt = Date.now();
  try {
    const res = await fetch(new URL(HEALTH_PATH, `${baseUrl}/`).toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 404) return probeInfo(baseUrl, token);
    const at = Date.now();
    if (!res.ok) return { at, ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const healthStatus =
      body.status === 'ok' || body.status === 'degraded' || body.status === 'error'
        ? body.status
        : undefined;
    return {
      at,
      ok: true,
      latencyMs: at - startedAt,
      ...(healthStatus ? { healthStatus } : {}),
      componentIssues: extractComponentIssues(body),
      // `/health`'s `startedAt` is an ISO timestamp (vs `/info`'s epoch ms).
      ...(typeof body.startedAt === 'string' && !Number.isNaN(Date.parse(body.startedAt))
        ? { gatewayStartedAt: Date.parse(body.startedAt) }
        : {}),
      ...(typeof body.uptimeMs === 'number' ? { gatewayUptimeMs: body.uptimeMs } : {}),
    };
  } catch (err) {
    return {
      at: Date.now(),
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function notify(action: GatewayAlertAction, label: string): void {
  if (!Notification.isSupported()) return;
  const n =
    action.kind === 'down'
      ? new Notification({
          title: 'Gateway unreachable',
          body: `“${label}” has been down for ${formatDurationMs(action.downForMs)}. Centraid can’t reach it.`,
          urgency: 'critical',
        })
      : new Notification({
          title: 'Gateway back online',
          body: `“${label}” recovered after ${formatDurationMs(action.outageMs)}.`,
        });
  n.show();
}

/** Component-level down alert (issue #351) — de-duped by `applyComponentAlerts`. */
function notifyComponent(action: GatewayComponentAlertAction, gatewayLabel: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: 'Gateway component unhealthy',
    body:
      `“${action.component}” on “${gatewayLabel}” has been erroring for ` +
      `${formatDurationMs(action.downForMs)}${action.message ? `: ${action.message}` : '.'}`,
    urgency: 'critical',
  });
  n.show();
}

/** Fired once when the embedded local gateway's supervised restart gives up (issue #351). */
function notifyCrashLoop(gatewayLabel: string, lastError: string | undefined): void {
  if (!Notification.isSupported()) return;
  const windowMinutes = Math.round(CRASH_LOOP_WINDOW_MS / 60_000);
  const n = new Notification({
    title: 'Gateway failed repeatedly',
    body:
      `“${gatewayLabel}” failed to start ${CRASH_LOOP_THRESHOLD}+ times in the last ` +
      `${windowMinutes} minutes — Centraid stopped retrying automatically.` +
      (lastError ? ` Last error: ${lastError}.` : '') +
      ' Use Settings → Gateway to restart it manually.',
    urgency: 'critical',
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
  // `loadSettings()` resolves (and, for a local gateway, lazily boots) the
  // active gateway — it can reject on its own, most notably when the
  // embedded local gateway is mid-backoff or crash-looped (local-gateway.ts's
  // supervision guard fails fast rather than hanging). Before supervision
  // existed this rejection just aborted the tick silently every 5s with
  // nothing visible; now, when we've tracked this gateway before, keep
  // folding a synthetic down probe through the SAME state so the down
  // alert / crash-loop notification below still fire. A cold-boot failure
  // (no prior state at all) has nothing to key tracking off yet — it's
  // covered separately by main.ts's launch-time error dialog — so this
  // tick just logs and waits for the next one.
  let settings: Awaited<ReturnType<typeof loadSettings>> | undefined;
  let settingsError: string | undefined;
  try {
    settings = await loadSettings();
  } catch (err) {
    settingsError = err instanceof Error ? err.message : String(err);
    if (!state) {
      process.stdout.write(
        `[gateway-monitor] settings unavailable, no prior state to track: ${settingsError}\n`,
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
        Date.now(),
      );
    }
    // Label/kind can change without a gateway switch (rename) — carry them.
    state = {
      ...state,
      gatewayLabel: settings.activeGatewayLabel,
      gatewayKind: settings.activeGatewayKind,
    };
  }
  // From here on `state` is always defined: either `settings` resolved (the
  // branch above just (re)established it) or it didn't and we already
  // returned early above when there was no prior state to fall back to.
  const trackedState = state as GatewayRuntimeState;

  // For the embedded local gateway, a crash-looped supervisor (issue #351:
  // ≥3 failed starts in ~2 minutes) means there's nothing listening and
  // never will be until a manual restart — skip the network round-trip and
  // report the real startup error as the down reason instead of a generic
  // connection failure. Also covers a `loadSettings()` rejection itself
  // (see above): in the common case that IS the local gateway failing to
  // boot, so we still attribute it to the supervisor when the tracked
  // gateway is local.
  const activeGatewayKind = settings?.activeGatewayKind ?? trackedState.gatewayKind;
  const localSupervisor =
    activeGatewayKind === 'local'
      ? getLocalGatewaySupervisorState(trackedState.gatewayId)
      : undefined;
  const probe: GatewayProbe = !settings
    ? { at: Date.now(), ok: false, detail: settingsError ?? 'settings unavailable' }
    : localSupervisor?.loopBroken
      ? {
          at: Date.now(),
          ok: false,
          detail: localSupervisor.lastError ?? 'local gateway failed repeatedly',
        }
      : settings.gatewayUrl
        ? await probeGateway(settings.gatewayUrl, settings.gatewayToken)
        : { at: Date.now(), ok: false, detail: 'gateway URL not resolved yet' };
  state = applyProbe(trackedState, probe);

  const alert: GatewayAlertConfig = {
    enabled: settings?.gatewayAlertsEnabled ?? true,
    thresholdSeconds: settings?.gatewayAlertSeconds ?? DEFAULT_ALERT_SECONDS,
  };
  const evaluated = evaluateAlert(state, alert, Date.now());
  state = evaluated.state;
  if (evaluated.action) notify(evaluated.action, state.gatewayLabel);

  // Per-component down alert (issue #351) — same enable switch as the
  // whole-gateway alert, a longer default threshold (see
  // DEFAULT_COMPONENT_ALERT_SECONDS), de-duped per component.
  const componentAlert: GatewayAlertConfig = {
    enabled: alert.enabled,
    thresholdSeconds: DEFAULT_COMPONENT_ALERT_SECONDS,
  };
  const componentEvaluated = applyComponentAlerts(state, Date.now(), componentAlert);
  state = componentEvaluated.state;
  for (const action of componentEvaluated.actions) notifyComponent(action, state.gatewayLabel);

  // Crash-loop alert — fires once per loop-broken episode; clears when the
  // supervisor recovers (a manual restart, or the app relaunching) so a
  // later crash loop can alert again.
  if (localSupervisor?.loopBroken) {
    if (!crashLoopNotified.has(state.gatewayId)) {
      crashLoopNotified.add(state.gatewayId);
      notifyCrashLoop(state.gatewayLabel, localSupervisor.lastError);
    }
  } else {
    crashLoopNotified.delete(state.gatewayId);
  }

  // `componentAlerts` is internal dedupe bookkeeping — not part of the wire
  // snapshot (see GatewayRuntimeSnapshot's doc comment).
  const { componentAlerts: _componentAlerts, ...publicState } = state;
  lastSnapshot = { ...publicState, alert, pollIntervalMs: GATEWAY_RUNTIME_POLL_MS };
  broadcast(lastSnapshot);
}

/** Run one tick, coalescing concurrent callers onto the same pass. */
function runTick(): Promise<void> {
  if (!inFlight) {
    inFlight = tick()
      .catch((err) => {
        process.stdout.write(`[gateway-monitor] tick failed: ${String(err)}\n`);
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}

/** Start the heartbeat. Called once from main.ts after app ready. */
export function startGatewayMonitor(): void {
  if (timer) return;
  timer = setInterval(() => void runTick(), GATEWAY_RUNTIME_POLL_MS);
  // Don't let the poller alone keep the process alive at quit.
  timer.unref?.();
  void runTick();
}

export function stopGatewayMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/**
 * Snapshot for the GATEWAY_RUNTIME_GET IPC. Serves the last broadcast when
 * one exists (≤5s old); otherwise runs an immediate probe so the first
 * renderer read never sees an empty monitor.
 */
export async function getGatewayRuntimeSnapshot(): Promise<GatewayRuntimeSnapshot> {
  if (!lastSnapshot) await runTick();
  if (!lastSnapshot) throw new Error('gateway monitor produced no snapshot');
  return lastSnapshot;
}

/**
 * Re-probe + re-broadcast now instead of waiting out the interval. Called
 * after settings writes (threshold/toggle changes apply immediately) and
 * gateway switches (tracking resets against the new gateway right away).
 */
export function nudgeGatewayMonitor(): void {
  void runTick();
}
