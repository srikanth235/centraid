import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  base,
  makeHealth,
  noExportDiagnostics,
  noLoadHealth,
  noop,
  noRestartGateway,
  noStreamLogs,
  NOW,
  stubProps,
} from "./GatewayScreen.fixtures.js";
import GatewayScreen from "./GatewayScreen.js";
import type { GatewayScreenProps } from "./GatewayScreen.js";

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
    const btn = [...host.querySelectorAll("button")].find(
      (b) => b.title === `Open ${label}` || b.textContent?.startsWith(label)
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
    expect(host.textContent).not.toContain("‹ System");
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
          loadConnections: async () => [
            {
              canRemove: true,
              gatewayId: "remote-1",
              gatewayKind: "remote" as const,
              gatewayLabel: "Studio",
              isActive: false,
              status: "ready" as const,
              transportBadge: "iroh" as const,
              vaultCount: 2,
              vaults: undefined,
            },
          ],
          onRemove: vi.fn<(gatewayId: string, label: string) => void>(),
          onRename: vi.fn<(gatewayId: string, label: string) => void>(),
          onTest: vi.fn<(gatewayId: string, label: string) => void>(),
        }}
      />
    );
    await act(() => Promise.resolve());
    expect(host.querySelector("h1")?.textContent).toBe("Components");
    expect(host.textContent).toContain("none reporting");
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
    expect(host.textContent).toContain("When to tell you");
    expect(host.textContent).toContain("after 2m unreachable");
    expect(host.textContent).not.toContain("Turn off");
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
      host.querySelector('[data-testid="storage-limits-panel"]')
    ).not.toBeNull();
    expect(host.textContent).not.toContain("Rescan");
    expect(host.querySelector("input")).toBeNull();
  });

  it("names the unhealthy component and counts it on the Components row", async () => {
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
    expect(host.textContent).toContain("What’s wrong now");
    expect(host.textContent).toContain("Connections");
    expect(host.textContent).toContain("1 in trouble");
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

    const toggle = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Turn off"
    );
    expect(toggle).toBeDefined();
    await act(async () => toggle?.click());
    expect(onEnabled).toHaveBeenCalledWith(false);

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
      (b) => b.textContent === "Logs"
    ) as HTMLButtonElement;
    expect(jumpBtn).toBeDefined();
    await act(async () => jumpBtn.click());

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
    const openRestart = [...host.querySelectorAll("button")].find(
      (b) => b.title === "Read what a restart does, then decide"
    ) as HTMLButtonElement;
    expect(openRestart).toBeDefined();
    await act(async () => openRestart.click());
    const restartBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Restart it"
    ) as HTMLButtonElement;
    expect(restartBtn).toBeDefined();
    await act(async () => {
      restartBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRestartGateway).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Restart it"); // back to idle label
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
    const openRestart = [...host.querySelectorAll("button")].find(
      (b) => b.title === "Read what a restart does, then decide"
    ) as HTMLButtonElement;
    expect(openRestart).toBeDefined();
    await act(async () => openRestart.click());
    const restartBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Restart it"
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
