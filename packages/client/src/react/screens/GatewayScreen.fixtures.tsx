// Shared rig for the two GatewayScreen suites (`GatewayScreen.test.tsx` for
// what the overview RENDERS, `GatewayScreen.interactions.test.tsx` for what it
// does when pressed). One snapshot and one set of never-resolving bridge stubs,
// so the two files cannot drift on what "a healthy local gateway one hour into
// a session" means.

import { renderToStaticMarkup } from "react-dom/server";

import type { GatewayRuntimeSnapshot } from "../shell/routes/gatewayData.js";
import GatewayScreen from "./GatewayScreen.js";
import type { GatewayScreenProps } from "./GatewayScreen.js";
import type { GatewayHealthDTO } from "./SettingsDiagnosticsScreen.js";

export const T0 = Date.UTC(2026, 6, 11, 12, 0, 0);
export const NOW = T0 + 3_600_000; // one hour into the session

export const base: GatewayRuntimeSnapshot = {
  gatewayId: "local",
  gatewayLabel: "Local",
  gatewayKind: "local",
  trackingSince: T0,
  status: "up",
  statusSince: T0,
  lastCheckAt: NOW - 2000,
  latencyMs: 3,
  gatewayStartedAt: T0 - 60_000,
  gatewayUptimeMs: NOW - 2000 - (T0 - 60_000),
  version: "0.1.0",
  protocolVersion: 1,
  checksTotal: 720,
  checksFailed: 6,
  samples: [
    { at: NOW - 15_000, ok: true, latencyMs: 3 },
    { at: NOW - 10_000, ok: false },
    { at: NOW - 5000, ok: true, latencyMs: 4 },
  ],
  outages: [
    { startedAt: NOW - 10_000, endedAt: NOW - 5000, alertedAt: NOW - 8000 },
  ],
  alert: { enabled: true, thresholdSeconds: 120 },
  pollIntervalMs: 5000,
  alertHistory: [
    {
      at: NOW - 5000,
      kind: "recovered",
      durationMs: 5000,
      previousSession: false,
    },
  ],
};

export function makeHealth(
  over: Partial<GatewayHealthDTO> = {}
): GatewayHealthDTO {
  return {
    status: "ok",
    startedAt: new Date(T0).toISOString(),
    uptimeMs: 3_600_000,
    components: [],
    recentEvents: [],
    ...over,
  };
}

export const noop = (): void => {};
export const noLoadHealth = (): Promise<GatewayHealthDTO> =>
  Promise.resolve(makeHealth());
export const noStreamLogs = (): Promise<void> => new Promise<void>(() => {}); // never resolves — no lines, "live" shell only
export const noRestartGateway = (): Promise<{ ok: boolean; error?: string }> =>
  new Promise(() => {});
export const noExportDiagnostics = (): Promise<
  { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
> => new Promise(() => {});

export const stubProps = {
  onAlertSecondsChange: noop,
  onAlertsEnabledChange: noop,
  health: null,
  loadHealth: noLoadHealth,
  streamLogs: noStreamLogs,
  onRestartGateway: noRestartGateway,
  onExportDiagnostics: noExportDiagnostics,
} as const;
export const backupProps: NonNullable<GatewayScreenProps["backup"]> = {
  loadStatus: () => new Promise(() => {}),
  onRunNow: () => new Promise(() => {}),
  onConfirmRecoveryKit: () => new Promise(() => {}),
};

export const render = (
  snapshot: GatewayRuntimeSnapshot,
  health: GatewayHealthDTO | null = null
): string =>
  renderToStaticMarkup(
    <GatewayScreen
      snapshot={snapshot}
      now={NOW}
      onAlertSecondsChange={noop}
      onAlertsEnabledChange={noop}
      health={health}
      loadHealth={noLoadHealth}
      streamLogs={noStreamLogs}
      onRestartGateway={noRestartGateway}
      onExportDiagnostics={noExportDiagnostics}
    />
  );
