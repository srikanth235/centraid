import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_bmsl46 from "../../gateway-client.js";
import type * as TypeImport_1fc2oj6 from "./useShellApps.js";

const listApps = vi.fn<typeof TypeImport_bmsl46.listApps>();
vi.mock(import("../../gateway-client.js"), () => ({
  listApps: () => listApps(),
  listVaults: () => Promise.resolve([]),
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

let useShellApps: typeof TypeImport_1fc2oj6.useShellApps;
let root: Root | null = null;
let host: HTMLElement | null = null;

describe("useShellApps", () => {
  beforeEach(async () => {
    store.clear();
    (globalThis as unknown as { Icon: unknown }).Icon = {
      Todo: () => "",
      Habit: () => "",
      Sparkle: () => "",
    };
    (globalThis as unknown as { ICON_PALETTE: unknown }).ICON_PALETTE = {
      teal: "#3EC8B4",
      violet: "#7C5BD9",
      blue: "#4950F6",
    };
    listApps.mockReset();
    ({ useShellApps } = await import("./useShellApps.js"));
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    delete (window as { CentraidApi?: unknown }).CentraidApi;
  });

  let ctl: ReturnType<typeof useShellApps>;
  function Harness(): null {
    const nextController = useShellApps();
    useEffect(() => {
      ctl = nextController;
    }, [nextController]);
    return null;
  }
  async function mount(): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }
  async function unmount(): Promise<void> {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  }

  describe("useShellApps", () => {
    it("keeps the pinned apps and ignores every other listing row", async () => {
      store.set("home.userApps", [
        { id: "todos", name: "Todos", iconKey: "Todo", color: "#1" },
      ]);
      listApps.mockResolvedValue([
        { id: "todos", name: "Todos", kind: "app" },
        { id: "wip", name: "WIP", kind: "app" },
        { id: "auto1", name: "Cron", kind: "automation" },
      ]);
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["todos"]);
    });

    it("treats a first-party listing row as INSTALLED", async () => {
      listApps.mockResolvedValue([
        { id: "photos", name: "Photos", kind: "app" },
        { id: "tasks", name: "Tasks", kind: "app" },
        { id: "wip", name: "WIP", kind: "app" },
      ]);
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["photos", "tasks"]);
    });

    it("does not persist first-party rows into the pin store", async () => {
      listApps.mockResolvedValue([
        { id: "photos", name: "Photos", kind: "app" },
      ]);
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["photos"]);
      expect(store.get("home.userApps")).toBeUndefined();
    });

    it("never lists a first-party app twice when a pin also names it", async () => {
      store.set("home.userApps", [
        { id: "photos", name: "Photos", iconKey: "Todo", color: "#1" },
      ]);
      listApps.mockResolvedValue([
        { id: "photos", name: "Photos", kind: "app" },
      ]);
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["photos"]);
    });

    it("prunes orphan pins whose app no longer exists on the gateway", async () => {
      store.set("home.userApps", [
        { id: "todos", name: "Todos", iconKey: "Todo", color: "#1" },
        { id: "gone", name: "Gone", iconKey: "Todo", color: "#2" },
      ]);
      listApps.mockResolvedValue([{ id: "todos", name: "Todos", kind: "app" }]);
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["todos"]);
      expect(store.get("home.userApps") as unknown[]).toHaveLength(1);
    });

    it("overlays tile identity from the listing app.json", async () => {
      store.set("home.userApps", [
        { id: "todos", name: "Todos", iconKey: "Todo", color: "#old" },
      ]);
      listApps.mockResolvedValue([
        {
          id: "todos",
          name: "Todos",
          kind: "app",
          iconKey: "Habit",
          colorKey: "teal",
        },
      ]);
      await mount();
      expect(ctl.userApps[0]?.iconKey).toBe("Habit");
    });

    it("overlays a renamed app.json name/description onto the cached pin", async () => {
      store.set("home.userApps", [
        {
          id: "agenda",
          name: "Agenda",
          desc: "Old desc",
          iconKey: "Todo",
          color: "#old",
        },
      ]);
      listApps.mockResolvedValue([
        {
          id: "agenda",
          name: "Agenda Renamed",
          description: "New desc",
          kind: "app",
        },
      ]);
      await mount();
      expect(ctl.userApps[0]?.name).toBe("Agenda Renamed");
      expect(ctl.userApps[0]?.desc).toBe("New desc");
    });

    it("a vault switch parks the outgoing vault’s pins instead of pruning them", async () => {
      const api = (vaultId: string) => ({
        getGatewayAuth: async () => ({ baseUrl: "", vaultId }),
      });
      (window as unknown as { CentraidApi: unknown }).CentraidApi = api("A");
      store.set("home.userApps", [
        { id: "notes", name: "Notes", iconKey: "Todo", color: "#1" },
      ]);
      listApps.mockResolvedValue([{ id: "notes", name: "Notes", kind: "app" }]);
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["notes"]);

      (window as unknown as { CentraidApi: unknown }).CentraidApi = api("B");
      listApps.mockResolvedValue([]);
      await act(async () => ctl.refresh());
      expect(ctl.userApps).toStrictEqual([]);

      (window as unknown as { CentraidApi: unknown }).CentraidApi = api("A");
      listApps.mockResolvedValue([{ id: "notes", name: "Notes", kind: "app" }]);
      await act(async () => ctl.refresh());
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["notes"]);
    });

    it("paints the last known installed set when the listing cannot be reached", async () => {
      const api = (vaultId: string) => ({
        getGatewayAuth: async () => ({ baseUrl: "", vaultId }),
      });
      (window as unknown as { CentraidApi: unknown }).CentraidApi = api("A");
      listApps.mockResolvedValue([
        { id: "photos", name: "Photos", kind: "app" },
        { id: "tasks", name: "Tasks", kind: "app" },
      ]);
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["photos", "tasks"]);

      await unmount();
      listApps.mockRejectedValue(new Error("offline"));
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["photos", "tasks"]);
      expect(store.get("home.userApps")).toBeUndefined();
    });

    it("does not paint one vault's remembered set into another vault", async () => {
      const api = (vaultId: string) => ({
        getGatewayAuth: async () => ({ baseUrl: "", vaultId }),
      });
      (window as unknown as { CentraidApi: unknown }).CentraidApi = api("A");
      listApps.mockResolvedValue([
        { id: "photos", name: "Photos", kind: "app" },
      ]);
      await mount();
      expect(ctl.userApps.map((a) => a.id)).toStrictEqual(["photos"]);

      (window as unknown as { CentraidApi: unknown }).CentraidApi = api("B");
      listApps.mockRejectedValue(new Error("offline"));
      await act(async () => ctl.refresh());
      expect(ctl.userApps).toStrictEqual([]);
    });

    it("an unknown vault key changes nothing — it is not a vault", async () => {
      (window as unknown as { CentraidApi: unknown }).CentraidApi = {
        getGatewayAuth: async () => ({ baseUrl: "", vaultId: "A" }),
      };
      store.set("home.userApps", [
        { id: "notes", name: "Notes", iconKey: "Todo", color: "#1" },
      ]);
      listApps.mockResolvedValue([{ id: "notes", name: "Notes", kind: "app" }]);
      await mount();
      expect(store.get("home.userApps.vault")).toBe("A");

      (window as unknown as { CentraidApi: unknown }).CentraidApi = {
        getGatewayAuth: async () => {
          throw new Error("offline");
        },
      };
      await act(async () => ctl.refresh());
      expect((store.get("home.userApps") as UserAppMeta[]).map((a) => a.id)) //
        .toStrictEqual(["notes"]);
      expect(store.get("home.userApps.vault")).toBe("A");
    });

    it("forgets every remembered installed set when the shell re-scopes", async () => {
      const { resetInstalledAppsCache } = await import("./useShellApps.js");
      (window as unknown as { CentraidApi: unknown }).CentraidApi = {
        getGatewayAuth: async () => ({ baseUrl: "", vaultId: "A" }),
      };
      listApps.mockResolvedValue([
        { id: "photos", name: "Photos", kind: "app" },
      ]);
      await mount();
      expect(store.get("home.installedApps.byVault")).toBeDefined();
      resetInstalledAppsCache();
      expect(store.get("home.installedApps.byVault")).toBeUndefined();
    });

    it("setUserApps persists to the Store", async () => {
      listApps.mockResolvedValue([]);
      await mount();
      await act(async () => {
        ctl.setUserApps([
          {
            id: "x",
            name: "X",
            iconKey: "Todo",
            color: "#3",
          } as unknown as UserAppMeta,
        ]);
      });
      expect((store.get("home.userApps") as UserAppMeta[])[0]?.id).toBe("x");
    });
  });
});
