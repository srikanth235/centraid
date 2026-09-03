import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_storage from "../../../gateway-client-local-storage.js";
import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import type { ShellActions } from "../actions.js";
import type * as TypeImport_qcp7vy from "../actions.js";
import type * as TypeImport_1t4fyrr from "./HomeRoute.js";
import type * as TypeImport_sample from "./homeSample.js";
import type * as TypeImport_tiles from "./homeTileContent.js";

const getDailyBrief = vi.fn<typeof TypeImport_1gl5zx7.getDailyBrief>();
vi.mock(import("../../../gateway-client.js"), () => ({
  getDailyBrief: () => getDailyBrief(),
  getGatewayBackupStatus: () =>
    Promise.resolve({
      configured: false,
      recoveryKit: { confirmedAt: null },
      vaults: [],
    }),
  listGatewayDevices: () => Promise.resolve([]),
}));

vi.mock(import("../useGatewayRuntime.js"), () => ({
  useGatewayStatus: () => "up",
}));

const loadHomeTileContent =
  vi.fn<typeof TypeImport_tiles.loadHomeTileContent>();
vi.mock(import("./homeTileContent.js"), () => ({
  loadHomeTileContent: (input: Parameters<typeof loadHomeTileContent>[0]) =>
    loadHomeTileContent(input),
  homeTileReader: () =>
    Promise.resolve({ read: () => Promise.resolve({ rows: [] }) }),
}));

const getLocalStorageUsage =
  vi.fn<typeof TypeImport_storage.getLocalStorageUsage>();
vi.mock(import("../../../gateway-client-local-storage.js"), () => ({
  getLocalStorageUsage: () => getLocalStorageUsage(),
}));

const loadHomeSample = vi.fn<typeof TypeImport_sample.loadHomeSample>();
const seedHomeSample = vi.fn<typeof TypeImport_sample.seedHomeSample>();
const syncHomeSampleReplica =
  vi.fn<typeof TypeImport_sample.syncHomeSampleReplica>();
vi.mock(import("./homeSample.js"), () => ({
  NO_SAMPLE: { rows: 0, seedable: [] },
  clearHomeSample: () => Promise.resolve(),
  loadHomeSample: () => loadHomeSample(),
  seedHomeSample: (
    seedable: readonly string[],
    onProgress?: (progress: TypeImport_sample.HomeSampleProgress) => void
  ) => seedHomeSample(seedable, onProgress),
  syncHomeSampleReplica: () => syncHomeSampleReplica(),
}));

let HomeRoute: typeof TypeImport_1t4fyrr.default;
let ShellActionsProvider: typeof TypeImport_qcp7vy.ShellActionsProvider;
let root: Root | null = null;
let host: HTMLElement | null = null;

const navigate = vi.fn<ShellActions["navigate"]>();
const openCommandPalette = vi.fn<ShellActions["openCommandPalette"]>();

function makeActions(): ShellActions {
  return {
    showToast: vi.fn<ShellActions["showToast"]>(),
    openCommandPalette,
    openContextMenu: vi.fn<ShellActions["openContextMenu"]>(),
    confirm: vi.fn<ShellActions["confirm"]>(),
    navigate,
  };
}

const app = (id: string): UserAppMeta =>
  ({
    id,
    name: id,
    iconKey: "Todo",
    color: "#123",
    updatedAt: "2020-01-01T00:00:00Z",
  }) as unknown as UserAppMeta;

async function render(
  userApps: UserAppMeta[],
  appsLoading = false,
  autoSeedSample = false,
  onAutoSeedStarted = vi.fn<() => void>()
): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ShellActionsProvider value={makeActions()}>
        <HomeRoute
          appsLoading={appsLoading}
          autoSeedSample={autoSeedSample}
          onAutoSeedStarted={onAutoSeedStarted}
          userApps={userApps}
        />
      </ShellActionsProvider>
    );
    await flush();
  });
  return host;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("HomeRoute", () => {
  beforeEach(async () => {
    ({ default: HomeRoute } = await import("./HomeRoute.js"));
    ({ ShellActionsProvider } = await import("../actions.js"));
    getDailyBrief.mockReset().mockResolvedValue({
      date: "2026-07-29",
      events: [],
      tasks: [],
      newPhotos: 0,
      balanceMinor: 0,
      currency: "USD",
    });
    loadHomeTileContent.mockReset().mockResolvedValue({});
    getLocalStorageUsage.mockReset().mockResolvedValue({
      scannedAt: 0,
      totalBytes: 0,
      components: [],
      vaults: [],
      disk: null,
      limits: {
        totalLimitBytes: null,
        warnAtPercent: 90,
        journalLimitBytes: null,
      },
      limit: {
        status: "ok",
        fractionUsed: null,
        usedBytes: 0,
        limitBytes: null,
      },
    });
    loadHomeSample.mockReset().mockResolvedValue({ rows: 0, seedable: [] });
    seedHomeSample.mockReset().mockResolvedValue([]);
    syncHomeSampleReplica.mockReset().mockResolvedValue(undefined);
    navigate.mockClear();
    openCommandPalette.mockClear();
    (await import("../queryCache.js")).resetQueryCache();
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    document.body.innerHTML = "";
    root = null;
    host = null;
  });

  it("tiles the apps that have content, and invites the ones that do not", async () => {
    loadHomeTileContent.mockResolvedValue({
      photos: { total: 3, thumbs: ["a.jpg"] },
    });
    const el = await render([app("photos"), app("tasks")]);
    expect(el.querySelector('[data-testid="home-springboard"]')).toBeTruthy();
    const tiles = [...el.querySelectorAll('[data-testid="home-tile"]')];
    expect(tiles.map((t) => (t as HTMLElement).dataset.appId)).toStrictEqual([
      "photos",
    ]);
    expect(el.querySelector('[data-testid="home-start-band"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="home-first-run"]')).toBeNull();
  });

  it("opens an app from its tile", async () => {
    loadHomeTileContent.mockResolvedValue({
      photos: { total: 3, thumbs: ["a.jpg"] },
    });
    const el = await render([app("photos")]);
    (el.querySelector('[data-testid="home-tile"]') as HTMLElement).click();
    expect(navigate).toHaveBeenCalledWith({ kind: "app", id: "photos" });
  });

  it("a vault with no content anywhere gets the first-run instruction", async () => {
    const el = await render([app("photos"), app("tasks")]);
    expect(el.querySelector('[data-testid="home-first-run"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="home-tile"]')).toBeNull();
  });

  it("keeps Home in its loading treatment until installed apps settle", async () => {
    const el = await render([app("photos")], true);
    expect(el.querySelector('[data-testid="home-first-run"]')).toBeNull();
    expect(el.querySelector('[data-testid="home-tile"]')).toBeNull();
    expect(el.textContent).toContain("Reading your vault");
  });

  it("starts the sample week once when onboarding hands off to Home", async () => {
    loadHomeSample.mockResolvedValue({ rows: 0, seedable: ["tasks"] });
    seedHomeSample.mockResolvedValue(["tasks"]);
    const onAutoSeedStarted = vi.fn<() => void>();
    await render([app("tasks")], false, true, onAutoSeedStarted);
    await act(async () => {
      await flush();
    });
    expect(onAutoSeedStarted).toHaveBeenCalledOnce();
    expect(seedHomeSample).toHaveBeenCalledWith(
      ["tasks"],
      expect.any(Function)
    );
  });

  it("waits for the initial Home reads before auto-filling the sample week", async () => {
    loadHomeSample.mockResolvedValue({ rows: 0, seedable: ["tasks"] });
    seedHomeSample.mockResolvedValue(["tasks"]);
    let settleTiles: (() => void) | undefined;
    loadHomeTileContent.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleTiles = () => resolve({});
        })
    );

    await render([app("tasks")], false, true);
    await act(async () => {
      await flush();
    });
    expect(seedHomeSample).not.toHaveBeenCalled();

    await act(async () => {
      settleTiles?.();
      await flush();
    });
    expect(seedHomeSample).toHaveBeenCalledWith(
      ["tasks"],
      expect.any(Function)
    );
  });

  it("never builds tile content before the brief has settled", async () => {
    let settle: (() => void) | undefined;
    getDailyBrief.mockImplementation(
      async () =>
        new Promise((resolve) => {
          settle = () =>
            resolve({
              date: "2026-07-29",
              events: [{ at: "2026-07-29T09:00:00Z", id: "e1", title: "Run" }],
              tasks: [],
              newPhotos: 0,
              balanceMinor: 0,
              currency: "USD",
            });
        })
    );
    const el = await render([app("agenda")]);
    expect(loadHomeTileContent).not.toHaveBeenCalled();

    await act(async () => {
      settle?.();
      await flush();
    });
    expect(loadHomeTileContent.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of loadHomeTileContent.mock.calls)
      expect(input.brief).toBeDefined();
    expect(el).toBeTruthy();
  });

  it("refetches the tiles only after the replica has pulled the seeded rows", async () => {
    loadHomeSample.mockResolvedValue({ rows: 0, seedable: ["tasks"] });
    seedHomeSample.mockResolvedValue(["tasks"]);
    let finishSync: (() => void) | undefined;
    syncHomeSampleReplica.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSync = () => resolve();
        })
    );
    const el = await render([app("tasks")]);
    const briefCalls = getDailyBrief.mock.calls.length;
    const tileCalls = loadHomeTileContent.mock.calls.length;
    const seedButton = el.querySelector(
      '[data-testid="home-sample-offer"] button'
    ) as HTMLButtonElement;
    expect(seedButton).toBeTruthy();

    await act(async () => {
      seedButton.click();
      await flush();
    });
    expect(seedHomeSample).toHaveBeenCalledWith(
      ["tasks"],
      expect.any(Function)
    );
    expect(getDailyBrief).toHaveBeenCalledTimes(briefCalls);
    expect(loadHomeTileContent).toHaveBeenCalledTimes(tileCalls);

    await act(async () => {
      finishSync?.();
      await flush();
    });
    expect(getDailyBrief).toHaveBeenCalledTimes(briefCalls + 1);
    expect(loadHomeTileContent).toHaveBeenCalledTimes(tileCalls + 1);
  });

  it("advances the fill's progress per app, then names the replica catch-up", async () => {
    loadHomeSample.mockResolvedValue({
      rows: 0,
      seedable: ["agenda", "photos"],
    });
    let advance: (() => void) | undefined;
    let finishSeed: (() => void) | undefined;
    seedHomeSample.mockImplementation(async (seedable, onProgress) => {
      onProgress?.({ appId: "agenda", done: 0, total: seedable.length });
      await new Promise<void>((resolve) => {
        advance = () =>
          onProgress?.({ appId: "photos", done: 1, total: seedable.length });
        finishSeed = () => resolve();
      });
      return [...seedable];
    });
    let finishSync: (() => void) | undefined;
    syncHomeSampleReplica.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSync = () => resolve();
        })
    );
    const el = await render([app("agenda"), app("photos")]);
    const offer = (): Element | null =>
      el.querySelector('[data-testid="home-sample-offer"]');
    const label = (): string | undefined =>
      offer()?.querySelector(".workingLabel")?.textContent ?? undefined;
    const counts = (): string | undefined =>
      offer()?.querySelector(".workingCounts")?.textContent ?? undefined;

    await act(async () => {
      (offer()!.querySelector("button") as HTMLButtonElement).click();
      await flush();
    });
    expect(label()).toBe("Adding events…");
    expect(counts()).toBe("0 of 2 apps");

    await act(async () => {
      advance?.();
      await flush();
    });
    expect(label()).toBe("Adding photographs…");
    expect(counts()).toBe("1 of 2 apps");

    await act(async () => {
      finishSeed?.();
      await flush();
    });
    expect(label()).toBe("Catching up…");
    expect(counts()).toBe("2 of 2 apps");

    await act(async () => {
      finishSync?.();
      await flush();
    });
    expect(offer()?.querySelector(".working")).toBeFalsy();
  });

  it("leaves a mid-seed failure to the existing per-app handling", async () => {
    loadHomeSample.mockResolvedValue({
      rows: 0,
      seedable: ["agenda", "photos"],
    });
    seedHomeSample.mockImplementation(async (seedable, onProgress) => {
      onProgress?.({ appId: "agenda", done: 0, total: seedable.length });
      return ["agenda"];
    });
    const el = await render([app("agenda"), app("photos")]);
    const offer = (): Element | null =>
      el.querySelector('[data-testid="home-sample-offer"]');

    await act(async () => {
      (offer()!.querySelector("button") as HTMLButtonElement).click();
      await flush();
    });
    await act(async () => {
      await flush();
    });
    expect(syncHomeSampleReplica).toHaveBeenCalledOnce();
    expect(offer()?.querySelector(".working")).toBeFalsy();
    expect(offer()?.querySelector("button")).toBeTruthy();
  });

  it("carries no identity bar and no library shelf — the app bar owns those", async () => {
    const el = await render([app("photos")]);
    const labels = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("All apps");
    expect(labels).not.toContain("Settings");
    expect(el.querySelector('[data-testid="home-composer"]')).toBeNull();
    expect(el.querySelector('[data-testid="apps-grid"]')).toBeNull();
  });
});
