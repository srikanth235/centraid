import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildGatewayRows } from "../shell/gatewayRegistry.js";
import type { GatewayRow } from "../shell/gatewayRegistry.js";
import SettingsDiagnosticsScreen from "./SettingsDiagnosticsScreen.js";
import type {
  DiagnosticsConnectionsProps,
  GatewayHealthDTO,
  SettingsDiagnosticsBridgeProps,
} from "./SettingsDiagnosticsScreen.js";

function makeHealth(over: Partial<GatewayHealthDTO> = {}): GatewayHealthDTO {
  return {
    status: "ok",
    startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    uptimeMs: 3 * 60 * 60 * 1000,
    components: [
      {
        component: "vaults",
        status: "ok",
        detail: "1 vault mounted",
        errorCount: 0,
      },
      {
        component: "automations",
        status: "ok",
        detail: "scheduler running for 1 vault",
        errorCount: 0,
      },
      { component: "outbox", status: "ok", errorCount: 0 },
    ],
    recentEvents: [],
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("screens/SettingsDiagnosticsScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  async function mount(
    props: SettingsDiagnosticsBridgeProps
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<SettingsDiagnosticsScreen {...props} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  describe(SettingsDiagnosticsScreen, () => {
    it("renders the overall banner, component rows, and empty events state", async () => {
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockResolvedValue(makeHealth()),
      });
      expect(el.textContent).toContain("3 · all answering");
      const rows = el
        .querySelector('[data-testid="diag-components"]')!
        .querySelectorAll("fieldset > div");
      expect(rows).toHaveLength(3);
      expect(el.textContent).toContain("Vaults");
      expect(el.textContent).toContain("1 vault mounted");
      expect(el.textContent).toContain("Automation scheduler");
      expect(el.textContent).toContain(
        "Nothing logged since the gateway started."
      );
    });

    it("surfaces a failing component with its last error and the event tail", async () => {
      const health = makeHealth({
        status: "error",
        components: [
          {
            component: "vaults",
            status: "ok",
            detail: "1 vault mounted",
            errorCount: 0,
          },
          {
            component: "outbox",
            status: "error",
            lastError: "outbox drain failed: ECONNREFUSED",
            lastErrorAt: new Date().toISOString(),
            errorCount: 3,
          },
        ],
        recentEvents: [
          {
            at: new Date().toISOString(),
            component: "outbox",
            level: "error",
            message: "outbox drain failed: ECONNREFUSED",
          },
        ],
      });
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockResolvedValue(health),
      });
      expect(el.textContent).toContain("2 · 1 in trouble");
      expect(el.textContent).toContain("outbox drain failed: ECONNREFUSED");
      expect(el.textContent).toContain("3 errors since the gateway started");
      expect(el.textContent).toContain("failing");
      expect(el.textContent).toContain("1 since the gateway started");
    });

    it("re-fetches on Refresh", async () => {
      const loadHealth = vi
        .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
        .mockResolvedValue(makeHealth());
      const el = await mount({ loadHealth });
      expect(loadHealth).toHaveBeenCalledOnce();
      const refreshBtn = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Refresh")
      ) as HTMLButtonElement;
      await act(async () =>
        refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(loadHealth).toHaveBeenCalledTimes(2);
    });

    it("shows the load error when the gateway is unreachable", async () => {
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockRejectedValue(new Error("fetch failed")),
      });
      expect(el.textContent).toContain(
        "Couldn’t reach the gateway: fetch failed"
      );
    });

    it('offers a "View in logs" jump on failing components, not healthy ones', async () => {
      const onJumpToLogs =
        vi.fn<NonNullable<SettingsDiagnosticsBridgeProps["onJumpToLogs"]>>();
      const health = makeHealth({
        components: [
          { component: "vaults", status: "ok", errorCount: 0 },
          {
            component: "outbox",
            status: "error",
            errorCount: 2,
            lastError: "ECONNREFUSED",
          },
        ],
      });
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockResolvedValue(health),
        onJumpToLogs,
      });
      const jumpButtons = [...el.querySelectorAll("button")].filter(
        (b) => b.textContent === "Logs"
      );
      expect(jumpButtons).toHaveLength(1); // only the failing row offers it
      const jumpButton = jumpButtons[0]!;
      await act(async () =>
        jumpButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(onJumpToLogs).toHaveBeenCalledWith("outbox");
    });

    it("omits the jump link when no onJumpToLogs is wired (unchanged Settings-era behavior)", async () => {
      const health = makeHealth({
        components: [{ component: "outbox", status: "error", errorCount: 1 }],
      });
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockResolvedValue(health),
      });
      expect(
        [...el.querySelectorAll("button")].some((b) => b.textContent === "Logs")
      ).toBe(false);
    });

    it("renders a long multi-item detail string (disk/vaults) in full, with a title fallback", async () => {
      const longDetail =
        "vault 019f5079-vault-one: 42.3 MB (vault.db 30.1 MB, blobs 12.2 MB); " +
        "vault 019f5079-vault-two: 118.7 MB (vault.db 90.0 MB, blobs 28.7 MB); " +
        "disk free 12.4 GB of 500.0 GB (2.5% free) on /Users/owner/Library/Application Support/Centraid";
      const health = makeHealth({
        components: [
          {
            component: "disk",
            status: "ok",
            detail: longDetail,
            errorCount: 0,
          },
        ],
      });
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockResolvedValue(health),
      });
      expect(el.textContent).toContain(longDetail);
      expect(el.querySelector(`[title="${longDetail}"]`)).toBeNull();
    });

    it("surfaces resource metrics and friendly labels for hardware/load-shed components", async () => {
      const health = makeHealth({
        components: [
          {
            component: "hardware-profile",
            status: "ok",
            detail: "mode=Conserve (conserve); class=constrained",
            errorCount: 0,
          },
          {
            component: "event-loop",
            status: "degraded",
            detail:
              "Busy: pausing non-urgent background work so apps stay responsive",
            errorCount: 0,
          },
          {
            component: "load-shed",
            status: "degraded",
            detail: "Busy: pausing backups, sweeps, and other background work",
            errorCount: 0,
          },
          {
            component: "disk",
            status: "ok",
            detail: "4.0 GB free of 32.0 GB (12.5% free)",
            errorCount: 0,
          },
        ],
        metrics: {
          rssBytes: 200 * 1024 * 1024,
          outboxPending: 0,
          eventLoopLagP50Ms: 4,
          eventLoopLagP99Ms: 12.5,
          storageFsyncMs: 3.2,
          hardwareProfileClass: "constrained",
          resourceMode: "conserve",
          uptimeMs: 3_600_000,
        },
      });
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockResolvedValue(health),
      });
      expect(el.textContent).toContain("Hardware profile");
      expect(el.textContent).toContain("Responsiveness");
      expect(el.textContent).toContain("Background load");
      expect(el.textContent).toContain("Disk space");
      expect(el.textContent).toContain("pausing backups");
      const metrics = el.querySelector('[data-testid="diag-metrics"]');
      expect(metrics?.textContent).toContain("200.0 MB");
      expect(metrics?.textContent).toContain("p99 12.5 ms");
      expect(metrics?.textContent).toContain("3.2 ms");
      expect(metrics?.textContent).toContain("Conserve · constrained");
    });
  });

  describe("connections section", () => {
    const rows = (): GatewayRow[] =>
      buildGatewayRows(
        [
          {
            gatewayId: "local",
            gatewayKind: "local",
            gatewayLabel: "This Mac",
          },
          {
            gatewayId: "office",
            gatewayKind: "remote",
            gatewayLabel: "Office",
          },
        ],
        {
          local: {
            status: "ready",
            vaults: [
              { name: "Shared", vaultId: "s" },
              { name: "Personal", vaultId: "p" },
            ],
          },
          office: { status: "error", error: "unreachable", vaults: undefined },
        },
        "local"
      );

    type Act = (gatewayId: string, label: string) => void;

    async function mountWithConnections(
      over: Partial<DiagnosticsConnectionsProps> = {}
    ): Promise<{
      el: HTMLDivElement;
      onTest: ReturnType<typeof vi.fn<Act>>;
      onRename: ReturnType<typeof vi.fn<Act>>;
      onRemove: ReturnType<typeof vi.fn<Act>>;
    }> {
      const onTest = vi.fn<Act>();
      const onRename = vi.fn<Act>();
      const onRemove = vi.fn<Act>();
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockResolvedValue(makeHealth()),
        connections: {
          loadConnections: () => Promise.resolve(rows()),
          onRemove,
          onRename,
          onTest,
          ...over,
        },
      });
      return { el, onRemove, onRename, onTest };
    }

    const rowFor = (el: HTMLElement, label: string): HTMLElement =>
      [
        ...el.querySelectorAll<HTMLElement>(
          '[data-testid="diag-connections"] fieldset > div'
        ),
      ].find((row) => row.textContent?.startsWith(label))!;

    it("is absent entirely when the host exposes no registry", async () => {
      const el = await mount({
        loadHealth: vi
          .fn<SettingsDiagnosticsBridgeProps["loadHealth"]>()
          .mockResolvedValue(makeHealth()),
      });
      expect(el.querySelector('[data-testid="diag-connections"]')).toBeNull();
    });

    it("lists each host with its transport and what it serves", async () => {
      const { el } = await mountWithConnections();
      const local = rowFor(el, "This Mac");
      expect(local.textContent).toContain("This Mac");
      expect(local.textContent).toContain("active");
      expect(local.textContent).toContain("2 vaults · Shared, Personal");
      const office = rowFor(el, "Office");
      expect(office.textContent).toContain("iroh");
      expect(office.textContent).toContain("Offline");
    });

    it("fires test / rename / remove for the host whose row was clicked", async () => {
      const { el, onTest, onRename, onRemove } = await mountWithConnections();
      const office = rowFor(el, "Office");
      const click = (label: string): void => {
        const button = [...office.querySelectorAll("button")].find((b) =>
          b.textContent?.includes(label)
        )!;
        act(() => button.click());
      };
      click("Test connection");
      click("Rename");
      click("Remove");
      expect(onTest).toHaveBeenCalledWith("office", "Office");
      expect(onRename).toHaveBeenCalledWith("office", "Office");
      expect(onRemove).toHaveBeenCalledWith("office", "Office");
    });

    it("never offers to remove the primordial local host", async () => {
      const { el } = await mountWithConnections();
      const labels = [...rowFor(el, "This Mac").querySelectorAll("button")].map(
        (b) => b.textContent
      );
      expect(labels.some((l) => l?.includes("Remove"))).toBe(false);
    });

    it("says so rather than rendering an empty panel when nothing is registered", async () => {
      const { el } = await mountWithConnections({
        loadConnections: () => Promise.resolve([]),
      });
      expect(el.textContent).toContain("No hosts are registered");
    });
  });
});
