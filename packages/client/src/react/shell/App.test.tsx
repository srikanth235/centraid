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

type GatewayClient = typeof import("../../gateway-client.js");

const apiMocks = vi.hoisted(() => ({
  listAppScopes: vi.fn<GatewayClient["listAppScopes"]>(),
  listVaults: vi.fn<GatewayClient["listVaults"]>(),
}));

vi.mock(import("../../gateway-client.js") as Promise<unknown>, () => ({
  getUserPrefs: () => Promise.resolve({}),
  // The sidebar identity row + every scope picker read the member's scope
  // registry (#599). `undefined` is the "gateway has no scopes plane" answer,
  // which falls through to listVaults.
  listAppScopes: apiMocks.listAppScopes,
  listVaults: apiMocks.listVaults,
  saveUserPrefs: () => Promise.resolve(undefined),
  listApps: () =>
    Promise.resolve([{ id: "todos", name: "Todos", kind: "app" }]),
  listAutomations: () => Promise.resolve([]),
  listAutomationTurns: () => Promise.resolve([]),
  getInsightsSummary: () =>
    Promise.resolve({
      kpis: {
        totalTokens: 0,
        totalCostUsd: 0,
        agentReportedCostUsd: 0,
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
      byRunner: [],
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

// The renderer's client-local store is a plain module now; back it with an
// in-memory Map so the hooks read/write deterministically (vi.hoisted lets the
// mock factory close over `store` despite mock hoisting).
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock(import("./store.js") as Promise<unknown>, () => ({
  Store: {
    get: <T,>(k: string, d: T): T => (store.has(k) ? (store.get(k) as T) : d),
    set: (k: string, v: unknown) => store.set(k, v),
  },
}));

let App: typeof TypeImport_1mc1xey.default;
let root: Root | null = null;
let host: HTMLElement | null = null;

function seedShellGlobals(): void {
  // Ambient globals the real tileVisualFromListing (via useShellApps) probes.
  (globalThis as unknown as { Icon: unknown }).Icon = {
    Todo: () => "",
    Sparkle: () => "",
  };
  (globalThis as unknown as { ICON_PALETTE: unknown }).ICON_PALETTE = {
    violet: "#7C5BD9",
  };
  // gateway-client-core registers onGatewayChanged at module load — CentraidApi
  // must exist before the first App graph import.
  // `getSettings` feeds useBuilderEnabled (#434) — default omits builderEnabled,
  // so the builder stays hidden unless a test overrides it before mounting.
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    onGatewayChanged: () => {},
    onVaultChanged: () => {},
    getSettings: () => Promise.resolve({}),
  };
  // Home's buildHomeAppItems asks the tokens bridge for each tile's finish.
  (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
    tileFinish: () => ({
      background: "#111",
      boxShadow: "none",
      glyphColor: "#fff",
    }),
  };
}
describe("App suite", () => {
  // Import the App graph once. Under turbo --filter concurrency the first
  // transform of the shell can exceed a short per-test hook budget; re-importing
  // every beforeEach only repeats that cost without resetting module state we
  // care about (store + CentraidApi are re-seeded below).
  beforeAll(async () => {
    seedShellGlobals();
    ({ default: App } = await import("./App.js"));
  }, 60_000);

  beforeEach(() => {
    apiMocks.listAppScopes.mockReset().mockResolvedValue(undefined);
    apiMocks.listVaults.mockReset().mockResolvedValue([]);
    store.clear();
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
    it("renders the chrome frame with primary nav, opening on Home", async () => {
      const el = await mount();
      expect(el.querySelector(".window")).not.toBeNull();
      expect(el.textContent).toContain("Todos");
      expect(el.textContent).toContain("Automations");
      expect(el.textContent).toContain("Connectors");
      // Discover left the rail for the ⌘K palette (#667).
      expect(el.textContent).not.toContain("Discover");
      expect(el.textContent).not.toMatch(/Apps ·/u);
      expect(el.textContent).not.toContain("Starred");
      const activeHome = el.querySelector('[data-active="true"]');
      expect(activeHome?.textContent).toContain("Home");
    });

    it("navigates to Analytics via the sidebar and highlights it", async () => {
      const el = await mount();
      // Labelled "Analytics" since #667; the route + highlight key are still
      // `insights`, which is exactly the separation the rename relies on.
      const insightsBtn = [...el.querySelectorAll(".sbItem")].find(
        (b) => b.textContent?.trim() === "Analytics"
      ) as HTMLButtonElement;
      await act(async () => {
        insightsBtn.click();
      });
      const active = el.querySelector('[data-active="true"]');
      expect(active?.textContent).toContain("Analytics");
      // Analytics route mounts its own dashboard (a main-scroll body) once loaded.
      await act(async () => {
        await Promise.resolve();
      });
      expect(el.querySelector(".mainScroll")).not.toBeNull();
    });

    it("navigates to Automations via the sidebar (above Pages)", async () => {
      const el = await mount();
      const autoBtn = [...el.querySelectorAll(".sbItem")].find((b) =>
        b.textContent?.includes("Automations")
      ) as HTMLButtonElement;
      await act(async () => {
        autoBtn.click();
      });
      const active = el.querySelector('[data-active="true"]');
      expect(active?.textContent).toContain("Automations");
    });

    it("hides every builder entry point by default (#434 builder off)", async () => {
      const el = await mount();
      // No "Build new" in the sidebar and no composer hero on Home.
      expect(el.textContent).not.toContain("Build new");
      expect(el.querySelector(".composerInput")).toBeNull();
      // The ⌘K palette lists the app but no "Build a new app…" create row.
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

    it("keeps an actionable offline banner visible across the shell", async () => {
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
      const banner = el.querySelector("output");
      expect(banner?.textContent).toContain("Offline");
      expect(banner?.textContent).toContain("Check gateway");
    });

    it("reveals builder entry points when builderEnabled is set (#434 builder on)", async () => {
      (
        globalThis as unknown as { CentraidApi: { getSettings: unknown } }
      ).CentraidApi.getSettings = () =>
        Promise.resolve({ builderEnabled: true });
      const el = await mount();
      // useBuilderEnabled resolves getSettings() a tick after first paint.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(el.textContent).toContain("Build new");
      expect(el.querySelector(".composerInput")).not.toBeNull();
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true })
        );
      });
      const dialog = el.querySelector('[aria-label="Command palette"]');
      expect(dialog?.textContent).toContain("Build a new app…");
    });

    it("binds the sidebar toggle to the appearance pref", async () => {
      const el = await mount();
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "open"
      );
      const toggle = el.querySelector(
        '.tlSide [aria-label="Hide sidebar"]'
      ) as HTMLButtonElement;
      await act(async () => {
        toggle.click();
      });
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "closed"
      );
      expect(store.get("appearance.v2")).toMatchObject({ sidebarOpen: false });
    });

    it("switches the active vault through the sidebar switcher", async () => {
      apiMocks.listVaults.mockResolvedValue([
        { vaultId: "shared", name: "Shared", ownerPartyId: "owner" },
        { vaultId: "personal", name: "Personal", ownerPartyId: "owner" },
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
      // The whole identity row is the switcher (#608) — its label names the
      // vault and gateway it is switching, so match on the action.
      const switcher = el.querySelector<HTMLButtonElement>(
        'button[aria-label$="Switch vault or gateway."]'
      )!;
      await act(async () => switcher.click());
      const personal = document.querySelector<HTMLButtonElement>(
        '[data-vault-id="personal"]'
      )!;
      expect(personal.textContent).toContain("Personal");
      await act(async () => personal.click());
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "personal" });
    });

    // Issue #665 — the switcher is VAULTS ONLY, flattened across gateways.
    it("lists the vaults of every registered gateway in one list, and picking one on another gateway switches both", async () => {
      apiMocks.listVaults.mockResolvedValue([
        { vaultId: "shared", name: "Shared", ownerPartyId: "owner" },
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
        'button[aria-label$="Switch vault or gateway."]'
      )!;
      await act(async () => switcher.click());
      // Let both probes land and patch the open popover in place.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const pop = document.querySelector('[role="menu"]')!;
      // No Gateways section survives — one list, both gateways' vaults in it.
      expect(pop.textContent).not.toContain("Gateways");
      expect(pop.textContent).toContain("Shared");
      expect(pop.textContent).toContain("Studio");
      const studio = document.querySelector<HTMLButtonElement>(
        '[data-vault-id="studio"]'
      )!;
      // The gateway is named as quiet context because more than one is known.
      expect(studio.textContent).toContain("Office");
      await act(async () => studio.click());
      expect(order).toStrictEqual(["gateway:office", "vault:studio"]);
    });
  });

  describe("BuilderRouteRedirect (#434)", () => {
    it("replaces a stale builder route with Home on mount", async () => {
      const { BuilderRouteRedirect } = await import("./App.js");
      const replace =
        vi.fn<Parameters<typeof BuilderRouteRedirect>[0]["nav"]["replace"]>();
      const nav = { replace } as unknown as Parameters<
        typeof BuilderRouteRedirect
      >[0]["nav"];
      const el = document.createElement("div");
      document.body.append(el);
      const r = createRoot(el);
      await act(async () => {
        r.render(<BuilderRouteRedirect nav={nav} />);
      });
      expect(replace).toHaveBeenCalledWith({ kind: "home" });
      act(() => r.unmount());
      el.remove();
    });
  });
});
