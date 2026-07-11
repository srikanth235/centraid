/*
 * Gateway runtime monitor (main process).
 *
 * The desktop had no live "is the gateway up" signal at all — the renderer
 * only ever learned about an unreachable gateway when a data request failed.
 * This module owns the heartbeat: every {@link GATEWAY_RUNTIME_POLL_MS} it
 * probes the active gateway's `/centraid/_gateway/info` (the route built for
 * exactly this — cheap identity JSON), folds the result through the pure
 * core (gateway-monitor-core.ts), broadcasts the snapshot to every window,
 * and fires an OS notification when the gateway has been continuously
 * unreachable past the user's configured threshold (settings-backed,
 * default 2 minutes) — plus a paired "back online" notice on recovery.
 *
 * It lives in main, not the renderer, so the watch survives navigation and
 * alerts land even when the window is backgrounded. State is in-memory and
 * per-launch; switching the active gateway resets tracking (the history
 * belongs to the gateway it was recorded against).
 */

import { BrowserWindow, Notification } from 'electron';
import { loadSettings } from './settings.js';
import {
  applyProbe,
  DEFAULT_ALERT_SECONDS,
  evaluateAlert,
  formatDurationMs,
  initialRuntimeState,
  type GatewayAlertAction,
  type GatewayAlertConfig,
  type GatewayProbe,
  type GatewayRuntimeState,
} from './gateway-monitor-core.js';

export const GATEWAY_RUNTIME_POLL_MS = 5000;
/** A hung probe counts as down well before the next tick would queue up. */
const PROBE_TIMEOUT_MS = 4000;
/** Broadcast channel — keep in sync with `Channel` in ipc.ts + preload.ts. */
const RUNTIME_EVENT_CHANNEL = 'centraid:gateway-runtime:event';

/** The wire snapshot the renderer's Gateway page renders. */
export interface GatewayRuntimeSnapshot extends GatewayRuntimeState {
  alert: GatewayAlertConfig;
  pollIntervalMs: number;
}

let state: GatewayRuntimeState | undefined;
let lastSnapshot: GatewayRuntimeSnapshot | undefined;
let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;

async function probeInfo(baseUrl: string, token: string | undefined): Promise<GatewayProbe> {
  const startedAt = Date.now();
  try {
    const res = await fetch(new URL('/centraid/_gateway/info', `${baseUrl}/`).toString(), {
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

function broadcast(snapshot: GatewayRuntimeSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(RUNTIME_EVENT_CHANNEL, snapshot);
  }
}

async function tick(): Promise<void> {
  const settings = await loadSettings();
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

  const probe = settings.gatewayUrl
    ? await probeInfo(settings.gatewayUrl, settings.gatewayToken)
    : { at: Date.now(), ok: false, detail: 'gateway URL not resolved yet' };
  state = applyProbe(state, probe);

  const alert: GatewayAlertConfig = {
    enabled: settings.gatewayAlertsEnabled ?? true,
    thresholdSeconds: settings.gatewayAlertSeconds ?? DEFAULT_ALERT_SECONDS,
  };
  const evaluated = evaluateAlert(state, alert, Date.now());
  state = evaluated.state;
  if (evaluated.action) notify(evaluated.action, state.gatewayLabel);

  lastSnapshot = { ...state, alert, pollIntervalMs: GATEWAY_RUNTIME_POLL_MS };
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
