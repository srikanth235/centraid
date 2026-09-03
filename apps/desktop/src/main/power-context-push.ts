import { powerMonitor } from "electron";

const POWER_CONTEXT_PATH = "/centraid/_gateway/resource/power-context";
const PUSH_TIMEOUT_MS = 3000;

type ThermalPressure = "nominal" | "fair" | "serious" | "critical";

function currentThermalPressure(): ThermalPressure | null {
  const get = (powerMonitor as { getCurrentThermalState?: () => string })
    .getCurrentThermalState;
  if (typeof get !== "function") return null;
  try {
    const state = get.call(powerMonitor);
    return state === "nominal" ||
      state === "fair" ||
      state === "serious" ||
      state === "critical"
      ? state
      : null;
  } catch {
    return null;
  }
}

export async function pushPowerContext(
  baseUrl: string,
  token: string | undefined
): Promise<void> {
  try {
    const res = await fetch(
      new URL(POWER_CONTEXT_PATH, `${baseUrl}/`).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          onBattery: powerMonitor.isOnBatteryPower(),
          batteryPercent: null,
          charging: null,
          thermalPressure: currentThermalPressure(),
        }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      }
    );
    void res.body?.cancel().catch(() => {});
  } catch {
    // Intentionally empty.
  }
}

export function registerPowerContextListeners(onChange: () => void): void {
  powerMonitor.on("on-battery", onChange);
  powerMonitor.on("on-ac", onChange);
  powerMonitor.on("thermal-state-change", onChange);
}
