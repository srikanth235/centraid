import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type * as TypeImport_1mc1xey from "./App.js";
import { publishVitals, resetVitals } from "./routeVitals.js";

type GatewayClient = typeof import("../../gateway-client.js");

const apiMocks = vi.hoisted(() => ({
  listAppScopes: vi.fn<GatewayClient["listAppScopes"]>(),
  listVaults: vi.fn<GatewayClient["listVaults"]>(),
}));

vi.mock(import("../../gateway-client.js") as Promise<unknown>, () => ({
  getUserPrefs: () => Promise.resolve({}),
  readGatewayCapabilities: () =>
    Promise.resolve({ automations: true, connectors: true }),
  listAppScopes: apiMocks.listAppScopes,
  listVaults: apiMocks.listVaults,
  saveUserPrefs: () => Promise.resolve(undefined),
  listApps: () =>
    Promise.resolve([{ id: "todos", name: "Todos", kind: "app" }]),
  listAutomations: () => Promise.resolve([]),
  listAutomationTurnsByLane: () => Promise.resolve([]),
  listAutomationTurns: () => Promise.resolve([]),
  getInsightsSummary: () =>
    Promise.resolve({
      kpis: {
        totalTokens: 0,
        totalCostUsd: 0,
        harnessReportedCostUsd: 0,
        estimatedCostUsd: 0,
        forecastCostUsd: 0,
        generations: 0,
        retries: 0,
        failedRuns: 0,
        failedCostUsd: 0,
        appsTouched: 0,
        unpricedRuns: 0,
        unreportedRuns: 0,
      },
      daily: [],
      bySource: [],
      byHarness: [],
      byModel: [],
      byEffort: [],
      recent: [],
      windowDays: 30,
      generatedAt: 0,
    }),
  getNotifications: () =>
    Promise.resolve({
      decisions: {
        outbox: [],
        needsAuth: [],
        parked: [],
        scopeRequests: [],
        count: 0,
      },
      notices: [],
      unreadNoticeCount: 0,
    }),
  subscribeNotificationsChanges: () => Promise.resolve(),
  syncWebNotifications: () => Promise.resolve(),
}));

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock(import("./store.js") as Promise<unknown>, () => ({
  Store: {
    get: <T,>(k: string, d: T): T => (store.has(k) ? (store.get(k) as T) : d),
    set: (k: string, v: unknown) => {
      store.set(k, v);
    },
    remove: (k: string) => {
      store.delete(k);
    },
    removeByPrefix: (prefix: string) => {
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
  },
}));

let App: typeof TypeImport_1mc1xey.default;
let root: Root | null = null;
let host: HTMLElement | null = null;

function seedShellGlobals(): void {
  (globalThis as unknown as { Icon: unknown }).Icon = {
    Todo: () => "",
    Sparkle: () => "",
  };
  (globalThis as unknown as { ICON_PALETTE: unknown }).ICON_PALETTE = {
    violet: "#7C5BD9",
  };
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    onGatewayChanged: () => {},
    onVaultChanged: () => {},
    getSettings: () => Promise.resolve({}),
  };
  (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
    tileFinish: () => ({
      background: "#111",
      boxShadow: "none",
      glyphColor: "#fff",
    }),
  };
}
describe("App suite", () => {
  beforeAll(async () => {
    seedShellGlobals();
    ({ default: App } = await import("./App.js"));
  }, 60_000);

  beforeEach(() => {
    apiMocks.listAppScopes.mockReset().mockResolvedValue(undefined);
    apiMocks.listVaults.mockReset().mockResolvedValue([]);
    store.clear();
    resetVitals();
    store.set("home.userApps", [
      { id: "todos", name: "Todos", iconKey: "Todo", color: "#123" },
    ]);
    seedShellGlobals();
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  async function mount(): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<App />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return host;
  }

  describe("App root", () => {
    it("renders the frame with the stem launcher, opening on Home", async () => {
      const el = await mount();
      expect(el.querySelector(".window")).not.toBeNull();
      const bar = el.querySelector(".appBar")!;
      expect(bar.textContent).toContain("Home");
      expect(bar.textContent).not.toContain("Search everything");
      expect(bar.textContent).not.toContain("All apps");
      const stem = el.querySelector(".stem")!;
      expect(stem.textContent).toContain("Search");
      expect(stem.textContent).toContain("All apps");
      expect(stem.textContent).toContain("Home");
      expect(stem.textContent).toContain("Notifications");
      expect(stem.textContent).toContain("Activity");
      expect(stem.textContent).toContain("Vault");
      expect(stem.textContent).not.toContain("Automations");
      expect(stem.textContent).not.toContain("Connectors");
      expect(stem.textContent).not.toContain("Copies");
      expect(stem.textContent).not.toContain("System");
      expect(stem.textContent).not.toContain("Assistant");
      expect(stem.textContent).not.toContain("Starred");
      const activeHome = stem.querySelector('[data-active="true"]');
      expect(activeHome?.textContent).toContain("Home");
    });

    it("reaches an unpinned destination through the All-apps sheet", async () => {
      const el = await mount();
      await act(async () => {
        el.querySelectorAll<HTMLButtonElement>(".stemAllApps").forEach((b) =>
          b.click()
        );
      });
      const sheet = document.querySelector('[aria-label="All apps"]')!;
      expect(sheet).not.toBeNull();
      expect(sheet.textContent).toContain("Connectors");
      expect(sheet.textContent).toContain("Starred");
      const starred = [
        ...sheet.querySelectorAll<HTMLButtonElement>(".sheetRowOpen"),
      ].find((b) => b.textContent?.trim() === "Starred")!;
      await act(async () => {
        starred.click();
      });
      expect(el.querySelector('.stem [data-active="true"]')).toBeNull();
      await act(async () => {
        await Promise.resolve();
      });
      expect(el.querySelector(".mainScroll")).not.toBeNull();
    });

    it("navigates to a pinned destination from the stem and highlights it", async () => {
      store.set("launcher.pins", { automations: true });
      const el = await mount();
      const autoBtn = [
        ...el.querySelectorAll<HTMLButtonElement>(".stem .launchItem"),
      ].find((b) => b.textContent?.includes("Automations"))!;
      await act(async () => {
        autoBtn.click();
      });
      const active = el.querySelector('.stem [data-active="true"]');
      expect(active?.textContent).toContain("Automations");
    });

    it("names an operational route in the bar, and lets its loader fill the count line (#765)", async () => {
      store.set("launcher.pins", { automations: true });
      const el = await mount();
      const autoBtn = [
        ...el.querySelectorAll<HTMLButtonElement>(".stem .launchItem"),
      ].find((b) => b.textContent?.includes("Automations"))!;
      await act(async () => {
        autoBtn.click();
      });
      const bar = el.querySelector(".appBar")!;
      expect(bar.textContent).toContain("Automations");
      expect(bar.textContent).not.toContain("New automation");
      expect(bar.textContent).toContain("Templates");
      expect(el.querySelector(".opsCount")).toBeNull();

      await act(async () => {
        publishVitals("automations", {
          count: "6 automations · 1 failing · 1 paused",
          state: "ready",
        });
      });
      expect(el.querySelector(".opsCount")?.textContent).toBe(
        "6 automations · 1 failing · 1 paused"
      );
      expect(el.querySelector(".appBar")?.textContent).toContain(
        "New automation"
      );
      expect(el.querySelector(".appBar")?.textContent).toContain("Templates");

      await act(async () => {
        publishVitals("automations", { state: "loading" });
      });
      expect(el.querySelector(".appBar")?.textContent).not.toContain(
        "New automation"
      );
      expect(el.querySelector(".appBar")?.textContent).not.toContain(
        "Templates"
      );
      expect(el.querySelector(".opsCount")?.textContent).toBe(
        "Reading from the gateway"
      );
    });

    it("pins an unpinned destination onto the stem, and persists it", async () => {
      const el = await mount();
      await act(async () => {
        el.querySelector<HTMLButtonElement>(".stemAllApps")?.click();
      });
      const pin = document.querySelector<HTMLButtonElement>(
        '[aria-label="Pin Starred to the launcher"]'
      )!;
      expect(pin.getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        pin.click();
      });
      expect(el.querySelector(".stem")?.textContent).toContain("Starred");
      expect(store.get("launcher.pins")).toMatchObject({ starred: true });
    });

    it("hides every builder entry point by default (#434 builder off)", async () => {
      const el = await mount();
      expect(el.querySelector('[aria-label="New app"]')).toBeNull();
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true })
        );
      });
      const dialog = el.querySelector('[aria-label="Command palette"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain("Todos");
      expect(dialog?.textContent).not.toContain("Build a new app…");
    });

    it("opens the command palette through the legacy shell bridge", async () => {
      const el = await mount();
      await act(async () => {
        (
          globalThis as unknown as {
            Centraid: { openSearch: () => void };
          }
        ).Centraid.openSearch();
      });
      expect(el.querySelector('[aria-label="Command palette"]')).not.toBeNull();
    });

    it("reports offline on the one status line, with the reason inline", async () => {
      (
        globalThis as unknown as {
          CentraidApi: Record<string, unknown>;
        }
      ).CentraidApi.getGatewayRuntime = () =>
        Promise.resolve({ status: "down" });
      const el = await mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const line = el.querySelector<HTMLElement>(".statusLine")!;
      expect(line.dataset.offline).toBe("true");
      expect(line.textContent).toContain("Offline");
      expect(line.textContent).toContain("commits are disabled");
      expect(line.textContent).toContain("Check gateway");
    });

    it("offers no app-building entry point anywhere (#799)", async () => {
      const el = await mount();
      expect(el.querySelector('[aria-label="New app"]')).toBeNull();
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true })
        );
      });
      const dialog = el.querySelector('[aria-label="Command palette"]');
      expect(dialog?.textContent).not.toContain("Build a new app…");
    });

    it("hides the stem on request, and never on its own", async () => {
      const el = await mount();
      expect(el.querySelector(".stem")).not.toBeNull();
      const win = el.querySelector<HTMLElement>(".window")!;
      expect(win.dataset.stem).toBeUndefined();
      const toggle = el.querySelector<HTMLButtonElement>(
        '[aria-label="Hide sidebar"]'
      )!;
      await act(async () => toggle.click());
      expect(win.dataset.stem).toBe("hidden");
      expect(el.querySelector('[aria-label="Show sidebar"]')).not.toBeNull();
      expect(el.querySelector(".scrim")).toBeNull();
      await act(async () => {
        el.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click();
      });
      expect(win.dataset.stem).toBe("hidden");
      expect(store.get("shell.stemOpen")).toBe(false);
    });

    it("switches the active vault through the app bar's title", async () => {
      apiMocks.listVaults.mockResolvedValue([
        {
          vaultId: "shared",
          name: "Shared",
          ownerPartyId: "owner",
        },
        {
          vaultId: "personal",
          name: "Personal",
          ownerPartyId: "owner",
        },
      ]);
      const setActiveVault =
        vi.fn<(input: { vaultId: string }) => Promise<void>>();
      setActiveVault.mockResolvedValue(undefined);
      const centraidApi = (
        globalThis as unknown as {
          CentraidApi: Record<string, unknown>;
        }
      ).CentraidApi;
      centraidApi.getGatewayAuth = () => Promise.resolve({ vaultId: "shared" });
      centraidApi.setActiveVault = setActiveVault;

      const el = await mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const switcher = el.querySelector<HTMLButtonElement>(
        'button[aria-label$="Switch vault."]'
      )!;
      await act(async () => switcher.click());
      const personal = document.querySelector<HTMLButtonElement>(
        '[data-vault-id="personal"]'
      )!;
      expect(personal.textContent).toContain("Personal");
      await act(async () => personal.click());
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "personal" });
    });

    it("lists the vaults of every registered gateway in one list, and picking one on another gateway switches both", async () => {
      apiMocks.listVaults.mockResolvedValue([
        {
          vaultId: "shared",
          name: "Shared",
          ownerPartyId: "owner",
        },
      ]);
      const order: string[] = [];
      const setActiveVault = vi.fn<
        (input: { vaultId: string }) => Promise<undefined>
      >((input) => {
        order.push(`vault:${input.vaultId}`);
        return Promise.resolve(undefined);
      });
      const setActiveGateway = vi.fn<
        (input: { id: string }) => Promise<undefined>
      >((input) => {
        order.push(`gateway:${input.id}`);
        return Promise.resolve(undefined);
      });
      const centraidApi = (
        globalThis as unknown as {
          CentraidApi: Record<string, unknown>;
        }
      ).CentraidApi;
      centraidApi.getSettings = () =>
        Promise.resolve({ activeGatewayId: "local" });
      centraidApi.getGatewayAuth = () => Promise.resolve({ vaultId: "shared" });
      centraidApi.setActiveVault = setActiveVault;
      centraidApi.setActiveGateway = setActiveGateway;
      centraidApi.listGateways = () =>
        Promise.resolve([
          { id: "local", label: "This Mac", kind: "local" },
          { id: "office", label: "Office", kind: "remote" },
        ]);
      centraidApi.listGatewayVaults = (input: { gatewayId: string }) =>
        Promise.resolve(
          input.gatewayId === "local"
            ? { ok: true, vaults: [{ vaultId: "shared", name: "Shared" }] }
            : { ok: true, vaults: [{ vaultId: "studio", name: "Studio" }] }
        );

      const el = await mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const switcher = el.querySelector<HTMLButtonElement>(
        'button[aria-label$="Switch vault."]'
      )!;
      await act(async () => switcher.click());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const pop = document.querySelector('[role="menu"]')!;
      expect(pop.textContent).not.toContain("Gateways");
      expect(pop.textContent).toContain("Shared");
      expect(pop.textContent).toContain("Studio");
      const studio = document.querySelector<HTMLButtonElement>(
        '[data-vault-id="studio"]'
      )!;
      expect(studio.textContent).toContain("Office");
      await act(async () => studio.click());
      expect(order).toStrictEqual(["gateway:office", "vault:studio"]);
    });
  });
});
