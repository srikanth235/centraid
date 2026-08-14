import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayRuntimeSnapshot } from "../shell/routes/gatewayData.js";
import GatewayScreen from "./GatewayScreen.js";
import type { GatewayScreenProps } from "./GatewayScreen.js";
import type { GatewayHealthDTO } from "./SettingsDiagnosticsScreen.js";

const T0 = Date.UTC(2026, 6, 11, 12, 0, 0);
const NOW = T0 + 3_600_000; // one hour into the session

const base: GatewayRuntimeSnapshot = {
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

function makeHealth(over: Partial<GatewayHealthDTO> = {}): GatewayHealthDTO {
  return {
    status: "ok",
    startedAt: new Date(T0).toISOString(),
    uptimeMs: 3_600_000,
    components: [],
    recentEvents: [],
    ...over,
  };
}

const noop = (): void => {};
const noLoadHealth = (): Promise<GatewayHealthDTO> =>
  Promise.resolve(makeHealth());
const noStreamLogs = (): Promise<void> => new Promise<void>(() => {}); // never resolves — no lines, "live" shell only
const noRestartGateway = (): Promise<{ ok: boolean; error?: string }> =>
  new Promise(() => {});
const noExportDiagnostics = (): Promise<
  { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
> => new Promise(() => {});

const stubProps = {
  onAlertSecondsChange: noop,
  onAlertsEnabledChange: noop,
  health: null,
  loadHealth: noLoadHealth,
  streamLogs: noStreamLogs,
  onRestartGateway: noRestartGateway,
  onExportDiagnostics: noExportDiagnostics,
} as const;
const backupProps: NonNullable<GatewayScreenProps["backup"]> = {
  loadStatus: () => new Promise(() => {}),
  onRunNow: () => new Promise(() => {}),
  onConfirmRecoveryKit: () => new Promise(() => {}),
};

const render = (
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

describe("GatewayScreen — Overview tab (default)", () => {
  it("renders the operational hero with the gauge cluster", () => {
    const html = render(base);
    expect(html).toContain("<h1>System</h1>");
    expect(html).toContain("Answering");
    expect(html).toContain("local gateway “Local”");
    expect(html).toContain("3 ms");
    expect(html).toContain("99.2%"); // (720-6)/720
    expect(html).toContain("720 checks this session");
    expect(html).toContain('data-status="up"');
    // Server uptime figure ticks forward from the last heartbeat.
    expect(html).toContain("1h 01m 00s");
  });

  it("keeps the overview free of tabs and offers drill-in pages", () => {
    const html = render(base);
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("Components");
    expect(html).toContain("Logs");
    expect(html).toContain("Alert history");
  });

  it("keeps backup and recovery controls on Overview", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        backup={backupProps}
      />
    );
    expect(html).toContain("Backups");
  });

  it("carries backup-alert arrival copy and orders Backups first", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        backup={backupProps}
        cause="backup-alert"
        focus="backups"
      />
    );
    expect(html).toContain("You arrived from the backup alert");
    expect(html.indexOf("Backups")).toBeLessThan(html.indexOf("Answering"));
  });

  it("leads with replica freshness and removes host-only restart for a viewer", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen snapshot={base} now={NOW} {...stubProps} readOnly />
    );
    expect(html).toContain("This browser last synced");
    expect(html).toContain("Runs on Local");
    expect(html).toContain("Components");
    expect(html).toContain("Logs");
    expect(html).toContain("Alert history");
    expect(html).not.toContain("Restart gateway");
    expect(html).not.toContain("System · Back");
  });

  it("keeps viewer backup and capacity summaries on Overview without verbs", () => {
    const html = renderToStaticMarkup(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        backup={backupProps}
        loadLocalUsage={() => new Promise(() => {})}
        saveStorageLimits={() => new Promise(() => {})}
        readOnly
      />
    );
    expect(html).toContain("Backups");
    expect(html).toContain("On this machine");
    expect(html).toContain("Limits");
    expect(html).not.toContain("Back up now");
    expect(html).not.toContain("Rescan");
    expect(html).not.toContain(">Set<");
  });

  it("states the live session denominator without inventing 30-day history", () => {
    const html = render(base);
    expect(html).toContain("720 checks this session");
    expect(html).not.toContain("30 days");
    expect(html).not.toContain("Outage log");
  });

  it("renders the unreachable state with the failure detail and blanked gauges", () => {
    const html = render({
      ...base,
      status: "down",
      statusSince: NOW - 30_000,
      lastError: "fetch failed",
      outages: [...base.outages, { startedAt: NOW - 30_000 }],
    });
    expect(html).toContain("Not answering");
    expect(html).toContain('data-status="down"');
    expect(html).toContain("fetch failed");
    expect(html).not.toContain("1h 01m 00s"); // uptime blanks while down
  });

  it('reconciles a healthy heartbeat with a failing component into "Degraded"', () => {
    const html = render(base, makeHealth({ status: "error" }));
    expect(html).toContain("Degraded");
    expect(html).toContain('data-status="degraded"');
    // Heartbeat itself is still up — the uptime figure keeps ticking.
    expect(html).toContain("1h 01m 00s");
  });

  it("lets the heartbeat win when the process is unreachable, even with healthy components", () => {
    const html = render(
      { ...base, status: "down" },
      makeHealth({ status: "ok" })
    );
    expect(html).toContain("Not answering");
    expect(html).toContain('data-status="down"');
  });
});

describe("GatewayScreen interactions", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const openDetail = async (label: string): Promise<void> => {
    const btn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith(label)
    ) as HTMLButtonElement;
    await act(async () => btn.click());
  };

  const renderScreen = async (element: Parameters<Root["render"]>[0]) =>
    act(async () => root.render(element));

  it("lets a viewer navigate to read-only System drill-ins", async () => {
    await renderScreen(
      <GatewayScreen snapshot={base} now={NOW} {...stubProps} readOnly />
    );
    await openDetail("Components");
    expect(host.querySelector("h1")?.textContent).toBe("Components");
    expect(host.textContent).toContain("System · Back");
  });

  it("keeps deep-linked Components visible but suppresses connection verbs for a viewer", async () => {
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        initialTab="components"
        readOnly
        connections={{
          loadConnections: async () => [],
          onRemove: vi.fn<(gatewayId: string, label: string) => void>(),
          onRename: vi.fn<(gatewayId: string, label: string) => void>(),
          onTest: vi.fn<(gatewayId: string, label: string) => void>(),
        }}
      />
    );
    await act(() => Promise.resolve());
    expect(host.querySelector("h1")?.textContent).toBe("Components");
    expect(host.textContent).toContain("All systems go");
    expect(
      host.querySelector('[data-testid="diag-connections"]')
    ).not.toBeNull();
    expect(host.textContent).not.toContain("Test connection");
    expect(host.textContent).not.toContain("Rename");
    expect(host.textContent).not.toContain("Remove");
  });

  it("suppresses export and mutation verbs on viewer Logs and Alerts deep links", async () => {
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        initialTab="logs"
        readOnly
      />
    );
    expect(host.querySelector("h1")?.textContent).toBe("Logs");
    expect(host.textContent).not.toContain("Export diagnostics");

    act(() => root.unmount());
    root = createRoot(host);
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        initialTab="alerts"
        readOnly
      />
    );
    expect(host.querySelector("h1")?.textContent).toBe("Alert history");
    expect(host.textContent).toContain("Alerts after 2m unreachable.");
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(host.textContent).not.toContain("Start Centraid at login");
  });

  it("renders live capacity read-only for a viewer deep-linked to Storage", async () => {
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        initialTab="storage"
        readOnly
        loadLocalUsage={async () => ({
          scannedAt: NOW,
          totalBytes: 1024,
          components: [{ component: "logs", bytes: 1024, files: 1 }],
          vaults: [],
          disk: { freeBytes: 2048, totalBytes: 4096 },
          limits: {
            totalLimitBytes: 4096,
            warnAtPercent: 80,
            journalLimitBytes: 2048,
          },
          limit: {
            status: "ok",
            fractionUsed: 0.25,
            usedBytes: 1024,
            limitBytes: 4096,
          },
        })}
        saveStorageLimits={() => new Promise(() => {})}
      />
    );
    await act(
      async () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        })
    );
    expect(host.querySelector("h1")?.textContent).toBe("Storage");
    expect(host.textContent).toContain("1.0 KB");
    expect(
      host.querySelector('[data-testid="storage-limits-read-only"]')
    ).not.toBeNull();
    expect(host.textContent).not.toContain("Rescan");
    expect(host.querySelector("input")).toBeNull();
  });

  it("shows the Components tab badge count from unhealthy components", async () => {
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        onAlertSecondsChange={noop}
        onAlertsEnabledChange={noop}
        health={makeHealth({
          status: "error",
          components: [
            { component: "vaults", status: "ok", errorCount: 0 },
            { component: "connections", status: "error", errorCount: 4 },
          ],
        })}
        loadHealth={noLoadHealth}
        streamLogs={noStreamLogs}
        onRestartGateway={noRestartGateway}
        onExportDiagnostics={noExportDiagnostics}
      />
    );
    const componentsTab = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Components")
    );
    expect(componentsTab?.textContent).toContain("1");
  });

  it("moves the down-alert preset/switch controls under the Alerts tab", async () => {
    const onSeconds =
      vi.fn<NonNullable<GatewayScreenProps["onAlertSecondsChange"]>>();
    const onEnabled =
      vi.fn<NonNullable<GatewayScreenProps["onAlertsEnabledChange"]>>();
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        onAlertSecondsChange={onSeconds}
        onAlertsEnabledChange={onEnabled}
      />
    );
    expect(
      [...host.querySelectorAll("button")].some((b) => b.textContent === "5m")
    ).toBe(false);

    await openDetail("Alert history");
    const fiveMin = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "5m"
    );
    await act(async () => fiveMin?.click());
    expect(onSeconds).toHaveBeenCalledWith(300);

    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => toggle?.click());
    expect(onEnabled).toHaveBeenCalledWith(false);

    // Panel rendering itself is covered by AlertHistoryPanel.test.tsx.
    expect(
      host.querySelector('[data-testid="alert-history-panel"]')
    ).not.toBeNull();
  });

  it("switching to the Components tab mounts the diagnostics screen", async () => {
    const loadHealth = vi
      .fn<GatewayScreenProps["loadHealth"]>()
      .mockResolvedValue(
        makeHealth({
          components: [{ component: "vaults", status: "ok", errorCount: 0 }],
        })
      );
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        loadHealth={loadHealth}
      />
    );
    await openDetail("Components");
    await act(() => Promise.resolve());
    expect(loadHealth).toHaveBeenCalledWith();
    expect(host.textContent).toContain("Vaults");
  });

  it("switching to the Logs tab mounts the log stream", async () => {
    await renderScreen(
      <GatewayScreen snapshot={base} now={NOW} {...stubProps} />
    );
    await openDetail("Logs");
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
    expect(host.textContent).toContain("No log lines yet");
  });

  it("jumps from a failing component straight into a focused Logs search", async () => {
    const loadHealth = vi
      .fn<GatewayScreenProps["loadHealth"]>()
      .mockResolvedValue(
        makeHealth({
          status: "error",
          components: [
            {
              component: "connections",
              status: "error",
              lastError: "ETIMEDOUT",
              errorCount: 4,
            },
          ],
        })
      );
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        {...stubProps}
        loadHealth={loadHealth}
      />
    );
    await openDetail("Components");
    await act(() => Promise.resolve());
    const jumpBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "View in logs"
    ) as HTMLButtonElement;
    expect(jumpBtn).toBeDefined();
    await act(async () => jumpBtn.click());

    // Landed on the Logs tab, search box seeded with the component id.
    const search = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search?.value).toBe("connections");
  });

  it("does not invent backup data when the live wire is unavailable", async () => {
    await renderScreen(
      <GatewayScreen snapshot={base} now={NOW} {...stubProps} />
    );
    await act(() => Promise.resolve());
    expect(host.textContent).not.toContain("Backups");
    expect(host.textContent).not.toContain(
      "Save this recovery kit somewhere offline"
    );
    expect(host.textContent).toContain("System");
  });

  it("restarts the gateway and clears back to idle on success", async () => {
    const onRestartGateway = vi
      .fn<NonNullable<GatewayScreenProps["onRestartGateway"]>>()
      .mockResolvedValue({ ok: true });
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        onAlertSecondsChange={noop}
        onAlertsEnabledChange={noop}
        health={null}
        loadHealth={noLoadHealth}
        streamLogs={noStreamLogs}
        onRestartGateway={onRestartGateway}
        onExportDiagnostics={noExportDiagnostics}
      />
    );
    const restartBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Restart gateway")
    ) as HTMLButtonElement;
    expect(restartBtn).toBeDefined();
    await act(async () => {
      restartBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRestartGateway).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Restart gateway"); // back to idle label
  });

  it("surfaces a refused restart (remote gateway) inline without throwing", async () => {
    const onRestartGateway = vi
      .fn<NonNullable<GatewayScreenProps["onRestartGateway"]>>()
      .mockResolvedValue({
        ok: false,
        error: "restart is only available for a local gateway",
      });
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        onAlertSecondsChange={noop}
        onAlertsEnabledChange={noop}
        health={null}
        loadHealth={noLoadHealth}
        streamLogs={noStreamLogs}
        onRestartGateway={onRestartGateway}
        onExportDiagnostics={noExportDiagnostics}
      />
    );
    const restartBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Restart gateway")
    ) as HTMLButtonElement;
    await act(async () => {
      restartBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain(
      "restart is only available for a local gateway"
    );
  });

  it("exports diagnostics from the Logs tab toolbar and shows the saved path", async () => {
    const onExportDiagnostics = vi
      .fn<NonNullable<GatewayScreenProps["onExportDiagnostics"]>>()
      .mockResolvedValue({ ok: true, path: "/tmp/diag.json" });
    await renderScreen(
      <GatewayScreen
        snapshot={base}
        now={NOW}
        onAlertSecondsChange={noop}
        onAlertsEnabledChange={noop}
        health={null}
        loadHealth={noLoadHealth}
        streamLogs={noStreamLogs}
        onRestartGateway={noRestartGateway}
        onExportDiagnostics={onExportDiagnostics}
      />
    );
    await openDetail("Logs");
    const exportBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Export diagnostics")
    ) as HTMLButtonElement;
    expect(exportBtn).toBeDefined();
    await act(async () => {
      exportBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onExportDiagnostics).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("/tmp/diag.json");
  });

  it("shows nothing extra when the export dialog is canceled, and surfaces a real failure inline", async () => {
    const onExportDiagnostics = vi
      .fn<NonNullable<GatewayScreenProps["onExportDiagnostics"]>>()
      .mockResolvedValue({ ok: false, canceled: true });
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={null}
          loadHealth={noLoadHealth}
          streamLogs={noStreamLogs}
          onRestartGateway={noRestartGateway}
          onExportDiagnostics={onExportDiagnostics}
        />
      );
    });
    await openDetail("Logs");
    const exportBtn = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Export diagnostics")
    ) as HTMLButtonElement;
    await act(async () => {
      exportBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Saved to");
    expect(exportBtn.textContent).toContain("Export diagnostics"); // back to idle label
  });
});
