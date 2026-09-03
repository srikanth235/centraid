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

import type * as TypeImport_caps from "./App.js";
import { resetVitals } from "./routeVitals.js";

const caps = vi.hoisted(() => ({
  value: { automations: false, connectors: false } as
    | Record<string, boolean>
    | undefined,
}));

vi.mock(import("../../gateway-client.js") as Promise<unknown>, () => ({
  readGatewayCapabilities: () => Promise.resolve(caps.value),
  getUserPrefs: () => Promise.resolve({}),
  saveUserPrefs: () => Promise.resolve(undefined),
  listAppScopes: () => Promise.resolve(undefined),
  listVaults: () => Promise.resolve([]),
  listApps: () =>
    Promise.resolve([{ id: "todos", name: "Todos", kind: "app" }]),
  listAutomations: () => Promise.reject(new Error("route not mounted")),
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

let App: typeof TypeImport_caps.default;
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

function shim(): Record<string, () => void> {
  return (window as unknown as { Centraid: Record<string, () => void> })
    .Centraid;
}

describe("the shell on a gateway without the experimental features", () => {
  beforeAll(async () => {
    seedShellGlobals();
    ({ default: App } = await import("./App.js"));
  }, 60_000);

  beforeEach(() => {
    store.clear();
    resetVitals();
    caps.value = { automations: false, connectors: false };
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

  it("stands no gated destination in the launcher, and hides them in All apps too", async () => {
    const el = await mount();
    const stem = el.querySelector(".stem")!;
    expect(stem.textContent).toContain("Home");
    expect(stem.textContent).toContain("Vault");
    expect(stem.textContent).not.toContain("Automations");
    expect(stem.textContent).not.toContain("Connectors");
    expect(stem.textContent).not.toContain("Analytics");

    await act(async () => {
      el.querySelectorAll<HTMLButtonElement>(".stemAllApps").forEach((b) =>
        b.click()
      );
    });
    const sheet = document.querySelector('[aria-label="All apps"]')!;
    expect(sheet.textContent).toContain("Starred");
    expect(sheet.textContent).not.toContain("Automations");
    expect(sheet.textContent).not.toContain("Connectors");
  });

  it("walls a deep link into a gated route instead of failing silently", async () => {
    const el = await mount();
    await act(async () => {
      shim().openAutomations!();
    });
    expect(el.textContent).toContain("aren’t enabled on this gateway");
    expect(el.textContent).toContain("untouched");
    const bar = el.querySelector(".appBar")!;
    expect(bar.textContent).toContain("Automations");
    expect(bar.textContent).not.toContain("New automation");
    expect(bar.textContent).not.toContain("Templates");
  });

  it("walls connectors on its own gate", async () => {
    const el = await mount();
    await act(async () => {
      shim().openConnectors!();
    });
    expect(el.textContent).toContain("Connectors aren’t enabled");
  });

  it("keeps gated surfaces discoverable when the gateway advertises them", async () => {
    caps.value = { automations: true, connectors: true };
    const el = await mount();
    await act(async () => {
      el.querySelectorAll<HTMLButtonElement>(".stemAllApps").forEach((button) =>
        button.click()
      );
    });
    const sheet = document.querySelector('[aria-label="All apps"]')!;
    expect(sheet.textContent).toContain("Automations");
    expect(sheet.textContent).toContain("Connectors");
    expect(sheet.textContent).toContain("Activity");
    expect(el.textContent).not.toContain("aren’t enabled on this gateway");
  });

  it("reads an absent flag as off — an older gateway handshakes clean", async () => {
    caps.value = undefined;
    const el = await mount();
    expect(el.querySelector(".stem")!.textContent).not.toContain("Automations");
  });
});
