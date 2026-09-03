import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GATEWAY_CAPABILITIES } from "@centraid/core/protocol";

import type * as TypeImport_1mc1xey from "./App.js";

vi.mock(import("./routes/InlineAppRoute.js"), () => ({
  default: () => <div data-testid="inline-marker">INLINE</div>,
}));
vi.mock(import("./routes/inlineApps.js"), () => ({
  inlineAppLoader: (appId: string) =>
    appId === "tasks"
      ? () =>
          Promise.resolve({
            default: {
              appId: "tasks",
              pendingProjection: { appId: "tasks", actions: {} },
              changeTables: [],
              queries: {},
              Root: () => null,
            },
          })
      : undefined,
  isInlineApp: (appId: string) => appId === "tasks",
}));

vi.mock(import("../../gateway-client.js"), () => ({
  getUserPrefs: () => Promise.resolve({}),
  readGatewayCapabilities: () =>
    Promise.resolve({
      ...DEFAULT_GATEWAY_CAPABILITIES,
      automations: true,
      connectors: true,
    }),
  saveUserPrefs: () => Promise.resolve({}),
  listApps: () =>
    Promise.resolve([
      { id: "tasks", name: "Tasks", kind: "app" },
      { id: "todos", name: "Todos", kind: "app" },
    ]),
  listAutomations: () => Promise.resolve([]),
  listAutomationTurnsByLane: () => Promise.resolve([]),
  listAutomationTurns: () => Promise.resolve([]),
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
vi.mock(import("./store.js"), () => ({
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

function openApp(id: string): void {
  (
    window as unknown as { Centraid: { openApp: (id: string) => void } }
  ).Centraid.openApp(id);
}

describe("App.inline-branch", () => {
  beforeEach(async () => {
    store.clear();
    store.set("home.userApps", [
      { id: "tasks", name: "Tasks", iconKey: "Todo", color: "#123" },
      { id: "todos", name: "Todos", iconKey: "Todo", color: "#456" },
    ]);
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
    ({ default: App } = await import("./App.js"));
  }, 60_000);

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
      await Promise.resolve();
    });
    return host;
  }

  describe("App — the inline app route (#505, #799)", () => {
    it("routes a registered inline id to InlineAppRoute", async () => {
      const el = await mount();
      await act(async () => openApp("tasks"));
      expect(el.querySelector('[data-testid="inline-marker"]')).not.toBeNull();
    });

    it("reports an unregistered id as missing instead of framing it", async () => {
      const el = await mount();
      await act(async () => openApp("todos"));
      expect(el.querySelector('[data-testid="inline-marker"]')).toBeNull();
      expect(el.textContent).toContain("App not found.");
    });
  });
});
