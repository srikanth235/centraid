/*
 * Power-context push (main process, #528 Phase D).
 *
 * The Electron desktop hosts the real battery; the embedded gateway can only
 * boot-probe it. This pushes live host power state to the active gateway's
 * `POST /centraid/_gateway/resource/power-context`, where it composes into the
 * gateway's courteous background-work deferral (power-context.ts). It is a
 * COURTESY signal only — the gateway never flips a durable mode from it.
 *
 * Cadence: pushed on `powerMonitor` transition events (immediacy) AND on the
 * gateway monitor's existing 5s heartbeat tick (freshness), so the gateway's
 * 120s staleness window is never approached while the desktop is running.
 * Electron exposes no battery PERCENT, so `batteryPercent` is always null —
 * the gateway's own boot probe supplies presence/percent; this supplies the
 * live on-battery/charging/thermal transitions the probe can't see.
 *
 * Failure-tolerant by design: the gateway may be mid-boot or down, so every
 * push swallows its error. It reuses the same bearer-token auth as
 * gateway-monitor.ts.
 */

import { powerMonitor } from 'electron';

const POWER_CONTEXT_PATH = '/centraid/_gateway/resource/power-context';
const PUSH_TIMEOUT_MS = 3000;

type ThermalPressure = 'nominal' | 'fair' | 'serious' | 'critical';

/** Map Electron's thermal state to the gateway's wire vocabulary; `unknown`/absent → null. */
function currentThermalPressure(): ThermalPressure | null {
  const get = (powerMonitor as { getCurrentThermalState?: () => string }).getCurrentThermalState;
  if (typeof get !== 'function') return null;
  try {
    const state = get.call(powerMonitor);
    return state === 'nominal' || state === 'fair' || state === 'serious' || state === 'critical'
      ? state
      : null;
  } catch {
    return null;
  }
}

/**
 * Push one live power-context snapshot to the gateway. Best-effort: any error
 * (gateway down, mid-boot, network) is swallowed — the gateway falls back to
 * its own boot probe and the next tick retries.
 */
export async function pushPowerContext(baseUrl: string, token: string | undefined): Promise<void> {
  try {
    const res = await fetch(new URL(POWER_CONTEXT_PATH, `${baseUrl}/`).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        onBattery: powerMonitor.isOnBatteryPower(),
        batteryPercent: null,
        charging: null,
        thermalPressure: currentThermalPressure(),
      }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    // Drain the body so the socket can be reused; status is advisory only.
    void res.body?.cancel().catch(() => {});
  } catch {
    /* gateway may be down or mid-boot — the heartbeat tick retries */
  }
}

/**
 * Register `powerMonitor` transition listeners so a battery/AC/thermal change
 * triggers an immediate push (via the injected nudge) instead of waiting out
 * the 5s heartbeat. `thermal-state-change` is macOS-only; listening for it on
 * other platforms is a harmless no-op.
 */
export function registerPowerContextListeners(onChange: () => void): void {
  powerMonitor.on('on-battery', onChange);
  powerMonitor.on('on-ac', onChange);
  powerMonitor.on('thermal-state-change', onChange);
}
