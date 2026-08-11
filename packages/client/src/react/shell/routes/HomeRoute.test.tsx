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

// Home is the springboard and nothing else (issue #708): no composer hero, no
// library shelf, and no identity bar — the app bar above the route carries the
// title and the two actions. What the route still owns is the two reads the
// tiles are made of, and the three treatments they resolve to (working, first
// run, the grid).

const getDailyBrief = vi.fn<typeof TypeImport_1gl5zx7.getDailyBrief>();
vi.mock(import("../../../gateway-client.js"), () => ({
  getDailyBrief: () => getDailyBrief(),
}));

const loadHomeTileContent =
  vi.fn<typeof TypeImport_tiles.loadHomeTileContent>();
vi.mock(import("./homeTileContent.js"), () => ({
  loadHomeTileContent: (input: Parameters<typeof loadHomeTileContent>[0]) =>
    loadHomeTileContent(input),
  // The tiles' content is stubbed wholesale, so the reader is never asked
  // anything — it exists only to satisfy the seam.
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
// The automatic first fill. `hasAutoSeeded` defaults to TRUE here — every case
// in this suite is about the surface, not about day one, and a mock that let
// the fill run would start one behind each of them. The auto-fill's own cases
// override it.
const hasAutoSeeded = vi.fn<typeof TypeImport_sample.hasAutoSeeded>();
const markAutoSeeded = vi.fn<typeof TypeImport_sample.markAutoSeeded>();
const autoSeedVaultId = vi.fn<typeof TypeImport_sample.autoSeedVaultId>();
vi.mock(import("./homeSample.js"), () => ({
  NO_SAMPLE: { rows: 0, seedable: [] },
  autoSeedVaultId: () => autoSeedVaultId(),
  clearHomeSample: () => Promise.resolve(),
  hasAutoSeeded: (vaultId: string) => hasAutoSeeded(vaultId),
  loadHomeSample: () => loadHomeSample(),
  markAutoSeeded: (vaultId: string) => markAutoSeeded(vaultId),
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
    builderEnabled: false,
    enterBuilder: vi.fn<ShellActions["enterBuilder"]>(),
    openNewAppSheet: vi.fn<ShellActions["openNewAppSheet"]>(),
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

async function render(userApps: UserAppMeta[]): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ShellActionsProvider value={makeActions()}>
        <HomeRoute userApps={userApps} drafts={[]} />
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
    // No disk budget set: `limitBytes: null` is the shape the gateway sends
    // when the owner has never capped local storage, and Home says nothing.
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
    hasAutoSeeded.mockReset().mockResolvedValue(true);
    markAutoSeeded.mockReset().mockResolvedValue(undefined);
    autoSeedVaultId.mockReset().mockResolvedValue("vault-1");
    navigate.mockClear();
    openCommandPalette.mockClear();
    // The route's reads live in the shared cache; start each case from an
    // empty one (issue #659).
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
    // Tasks is installed but empty, so it is a first move rather than a tile —
    // the grid holds what has something to show and nothing else.
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

  it("never builds tile content before the brief has settled", async () => {
    // The cache keys a query by its KEY, not by the closure — so a springboard
    // query that ran while the brief was still in flight cached a tileContent
    // derived from `brief === undefined` and never recomputed it. Agenda, tasks
    // and the tally figure are MADE of the brief, so they stayed missing no
    // matter how full the vault was. Every call must therefore see a brief.
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

  it("fills a fresh vault on its own, marking the vault BEFORE it writes", async () => {
    loadHomeSample.mockResolvedValue({ rows: 0, seedable: ["tasks"] });
    hasAutoSeeded.mockResolvedValue(false);

    await render([app("tasks")]);

    expect(seedHomeSample).toHaveBeenCalledWith(
      ["tasks"],
      expect.any(Function)
    );
    expect(markAutoSeeded).toHaveBeenCalledWith("vault-1");
    // Marked FIRST. A fill that dies halfway costs this vault its automatic
    // demonstration; the alternative is a vault that retries the write on
    // every visit for as long as it keeps failing.
    expect(markAutoSeeded.mock.invocationCallOrder[0]!).toBeLessThan(
      seedHomeSample.mock.invocationCallOrder[0]!
    );
  });

  it("never refills a vault whose sample was cleared", async () => {
    // The emptiness that triggers the automatic fill is exactly the state
    // "Clear the sample" produces, so without the durable marker clearing
    // would put the rows straight back and the control would be a no-op
    // wearing a label. This is the test that says clearing is FINAL.
    loadHomeSample.mockResolvedValue({ rows: 0, seedable: ["tasks"] });
    hasAutoSeeded.mockResolvedValue(true);

    await render([app("tasks")]);

    expect(seedHomeSample).not.toHaveBeenCalled();
    expect(markAutoSeeded).not.toHaveBeenCalled();
  });

  it("does not fill a vault it cannot name", async () => {
    // Writing invented rows into a vault the client cannot identify is the one
    // outcome this feature must never produce — and it is reachable, because
    // the vault id comes from a gateway read that can fail.
    loadHomeSample.mockResolvedValue({ rows: 0, seedable: ["tasks"] });
    hasAutoSeeded.mockResolvedValue(false);
    autoSeedVaultId.mockResolvedValue(null);

    await render([app("tasks")]);

    expect(seedHomeSample).not.toHaveBeenCalled();
    expect(markAutoSeeded).not.toHaveBeenCalled();
  });

  it("does not fill a vault that already carries sample rows", async () => {
    loadHomeSample.mockResolvedValue({ rows: 12, seedable: ["tasks"] });
    hasAutoSeeded.mockResolvedValue(false);

    await render([app("tasks")]);

    expect(seedHomeSample).not.toHaveBeenCalled();
  });

  it("refetches the tiles only after the replica has pulled the seeded rows", async () => {
    // The seed lands on the GATEWAY, but the tiles read the LOCAL REPLICA —
    // refreshing before the replica pulled rebuilt them from pre-seed rows,
    // which is the "pressed the button and nothing filled in until a reload"
    // bug. So the order is load-bearing: the replica sync resolves first, and
    // only then do the brief and the springboard feed refetch, exactly once.
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
    // The sync is still pending: refetching now would rebuild from pre-seed
    // rows, so nothing may have refetched yet.
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
    // The seed is about ten seconds of work and it used to be ten seconds of
    // one unchanging sentence. The route is what turns the run's position into
    // something Home can say: each app as it starts, then the catch-up while
    // the replica pulls — the beat where the counts are already full and the
    // tiles are still empty.
    loadHomeSample.mockResolvedValue({
      rows: 0,
      seedable: ["agenda", "photos"],
    });
    let advance: (() => void) | undefined;
    let finishSeed: (() => void) | undefined;
    seedHomeSample.mockImplementation(async (seedable, onProgress) => {
      onProgress?.({ appId: "agenda", done: 0, total: seedable.length });
      await new Promise<void>((resolve) => {
        // Two gates, because the two things have to be separable: the second
        // app STARTING is a different moment from the whole run FINISHING, and
        // the surface has to be right at both.
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

    // Generators done, replica still pulling: the counts are full and the
    // sentence has moved on rather than stalling on the last app.
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
    // The run is over: the offer's control is back, and nothing is still
    // claiming to be working.
    expect(offer()?.querySelector(".working")).toBeFalsy();
  });

  it("leaves a mid-seed failure to the existing per-app handling", async () => {
    // `seedHomeSample` swallows per app and reports by omission, so the route
    // never sees a rejection — it refreshes, drops the working state, and Home
    // shows whatever DID land. Unchanged by the progress work.
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
