// Home's springboard COMPOSITION (#905). Both units stayed green through the
// defect; only the composition saw it. Seam: `useReplicaQuery` alone, so the
// real tiles, grading and catalog run. Rationale: receipts/issue-905-*.md.
// Also the conformance sweep; see scripts/lint-app-conformance.mjs.

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../../app-conformance.json";
// @vitest-environment jsdom
import { mountBlock, nodesOf, press } from "../test/react-native-stub";
import HomeScreen from "./Home";
import {
  buildLauncherItems,
  orderByPins,
  orderForSpringboard,
} from "./home/catalog";

// `Partial<...>` per this repo's other stub-tier tests.
type ReactNative = typeof import("react-native");
type AsyncStorageModule =
  typeof import("@react-native-async-storage/async-storage");
type SafeAreaContext = typeof import("react-native-safe-area-context");
type NavigationModule = typeof import("@react-navigation/native");
type ThemeModule = typeof import("../kit/theme");
type GatewayModule = typeof import("../lib/gateway");
type VaultLinksModule = typeof import("../lib/vault-links");
type ThumbnailPackModule = typeof import("../lib/replica/thumbnail-pack");
type ReplicaQueryModule = typeof import("../kit/hooks/useReplicaQuery");
type ReplicaProviderModule = typeof import("../kit/replica/ReplicaProvider");
type OriginHealthModule = typeof import("./home/useOriginHealth");
type LauncherGridModule = typeof import("./home/LauncherGrid");
type FirstMovesModule = typeof import("./home/FirstMoves");

/** Flipped per test; read by the seam on every call. */
const reads = vi.hoisted(() => ({ readable: true, synced: true }));

vi.mock(import("react-native"), async () => {
  const stub = await import("../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    RefreshControl: () => null,
  } as unknown as Partial<ReactNative>;
});

vi.mock(
  import("@react-native-async-storage/async-storage"),
  async () =>
    (
      await import("../test/react-native-stub")
    ).asyncStorageStub() as unknown as Partial<AsyncStorageModule>
);

vi.mock(
  import("react-native-safe-area-context"),
  () =>
    ({
      useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
    }) as unknown as Partial<SafeAreaContext>
);

// Focus effects run once, as mount effects.
vi.mock(import("@react-navigation/native"), async () => {
  const ReactModule = await import("react");
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      ReactModule.useEffect(effect, [effect]);
    },
  } as unknown as Partial<NavigationModule>;
});

vi.mock(
  import("../kit/theme"),
  () =>
    ({
      pageMargin: 16,
      useTheme: () => ({ colors: { accent: "#accent", bg: "#bg" } }),
    }) as unknown as Partial<ThemeModule>
);

vi.mock(
  import("../lib/gateway"),
  () =>
    ({
      apiHeaders: () => ({}),
      fetchJson: vi.fn<() => Promise<unknown>>(async () => ({ apps: [] })),
      requireGatewayBase: vi.fn<() => Promise<string>>(
        async () => "http://127.0.0.1:7777"
      ),
      resolveGatewayBase: vi.fn<() => Promise<string | undefined>>(
        async () => "http://127.0.0.1:7777"
      ),
    }) as unknown as Partial<GatewayModule>
);

vi.mock(
  import("../lib/vault-links"),
  () =>
    ({
      getActiveVaultLink: () => undefined,
      subscribeVaultLinks: () => () => undefined,
    }) as unknown as Partial<VaultLinksModule>
);

vi.mock(
  import("../lib/replica/thumbnail-pack"),
  () =>
    ({
      pinnedThumbnailUri: () => undefined,
    }) as unknown as Partial<ThumbnailPackModule>
);

vi.mock(
  import("../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: vi.fn<ReplicaProviderModule["useReplica"]>(() => ({
        online: true,
        ready: true,
        refresh: vi.fn<() => Promise<void>>(async () => undefined),
        scopes: [],
      })),
    }) as unknown as Partial<ReplicaProviderModule>
);

// THE SEAM: `unavailable` is what a phone with no replica session reports.
vi.mock(import("../kit/hooks/useReplicaQuery"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useReplicaQuery: (): ReturnType<ReplicaQueryModule["useReplicaQuery"]> => ({
      connection: reads.readable
        ? ("current" as const)
        : ("unavailable" as const),
      error: undefined,
      lastSyncedAt: reads.synced ? "2026-09-01T05:20:00.000Z" : undefined,
      loading: false,
      refresh: async () => undefined,
      rows: [],
    }),
  } as unknown as Partial<ReplicaQueryModule>;
});

vi.mock(
  import("./home/useOriginHealth"),
  () =>
    ({
      useOriginHealth: () => ({ copy: "All good", tone: "quiet" }),
    }) as unknown as Partial<OriginHealthModule>
);

// Publishes the ids it was handed (the #905 claim) and one pressable each,
// under the grid's own handle expression.
vi.mock(import("./home/LauncherGrid"), async () => {
  const ReactModule = await import("react");
  const { TEST_ID_PREFIXES } = await import("../kit/test-ids");
  return {
    default: ({
      items,
      onOpen,
    }: {
      items: readonly { meta: { id: string } }[];
      onOpen: (item: { meta: { id: string } }) => void;
    }) =>
      ReactModule.createElement(
        "div",
        {
          "data-testid": "launcher-grid",
          "data-items": items.map((item) => item.meta.id).join(","),
        },
        items.map((item) =>
          ReactModule.createElement("button", {
            "data-testid": `${TEST_ID_PREFIXES.homeTile}${item.meta.id}`,
            key: item.meta.id,
            onClick: () => onOpen(item),
            type: "button",
          })
        )
      ),
  } as unknown as Partial<LauncherGridModule>;
});

vi.mock(import("./home/FirstMoves"), async () => {
  const ReactModule = await import("react");
  return {
    default: () => ReactModule.createElement("div"),
    DayOne: () =>
      ReactModule.createElement("div", { "data-testid": "day-one" }),
  } as unknown as Partial<FirstMovesModule>;
});

// Chrome this file makes no claim about. `vi.hoisted`: `vi.mock` lifts above
// ordinary bindings.
const blank = vi.hoisted(() => async () => {
  const ReactModule = await import("react");
  return { default: () => ReactModule.createElement("div") };
});
vi.mock(import("./home/VaultHeader"), blank);
vi.mock(import("./home/HomeTitleRow"), blank);
vi.mock(import("./home/HomeStatusLine"), blank);
vi.mock(import("./home/HomeBand"), blank);
vi.mock(import("./home/AllAppsSheet"), blank);
vi.mock(import("./home/VaultsSwitcher"), blank);
vi.mock(import("./home/SearchOverlay"), blank);

interface MountedHome {
  container: HTMLElement;
  routed: unknown[][];
}

function mountHome(): MountedHome {
  const routed: unknown[][] = [];
  const { container } = mountBlock(
    React.createElement(
      HomeScreen as unknown as React.ComponentType<{ navigation: unknown }>,
      {
        navigation: {
          navigate: (...args: unknown[]) => routed.push(args),
        },
      }
    )
  );
  return { container, routed };
}

function renderHome(): HTMLElement {
  return mountHome().container;
}

/** Ids off the launcher, or `undefined` if it never mounted. */
function gridItems(container: HTMLElement): string[] | undefined {
  const [grid] = nodesOf(container, '[data-testid="launcher-grid"]');
  const items = grid?.dataset.items;
  return items === undefined ? undefined : items.split(",").filter(Boolean);
}

/** Every app pre-grading; derived so adding one cannot narrow the claim. */
const everyLauncherId = orderByPins(
  orderForSpringboard(buildLauncherItems()),
  []
).map((item) => item.meta.id);

describe("Home springboard composition", () => {
  beforeEach(() => {
    reads.readable = true;
    reads.synced = true;
  });

  it("keeps every app on the grid when no tile can be read", () => {
    // #905: no replica session, so the per-tile rule demoted every tile.
    reads.readable = false;

    const container = renderHome();

    // EVERY app: Locker's body is a state, so it earned the grid even under
    // the old rule and would keep a laxer check green.
    expect(gridItems(container)).toStrictEqual(everyLauncherId);
    expect(nodesOf(container, '[data-testid="day-one"]')).toHaveLength(0);
  });

  it("still routes a genuinely empty vault to day one", () => {
    // The complement a careless fix breaks: `empty` is not `unknown`.
    const container = renderHome();

    expect(nodesOf(container, '[data-testid="day-one"]')).toHaveLength(1);
    expect(gridItems(container)).toBeUndefined();
  });

  it("keeps every app on the grid until a pull has landed", () => {
    reads.synced = false; // the CLONE has not arrived (#905 N)

    const container = renderHome();

    expect(gridItems(container)).toStrictEqual(everyLauncherId);
    expect(nodesOf(container, '[data-testid="day-one"]')).toHaveLength(0);
  });
});

// GENERATED: app #9 fails here, in the PR that registers it.

const CONFORMANCE = Object.entries(manifest.apps);

describe("shell↔app conformance", () => {
  beforeEach(() => {
    reads.readable = false;
  });

  it("sweeps exactly the apps the launcher builds", () => {
    // No-op guard: a drifted manifest sweeps the wrong set, greenly.
    expect(CONFORMANCE.map(([id]) => id).sort()).toStrictEqual(
      [...everyLauncherId].sort()
    );
  });

  describe.each(CONFORMANCE)("%s", (id, row) => {
    it("puts a tile on the launcher under its declared handle", () => {
      const { container } = mountHome();

      expect(gridItems(container)).toContain(id);
      expect(nodesOf(container, `[data-testid="${row.tile}"]`)).toHaveLength(1);
    });

    it("opens its own cover when the tile is pressed", () => {
      // The claim no unit sees. The sequence: one, to this cover.
      const { container, routed } = mountHome();

      press(nodesOf(container, `[data-testid="${row.tile}"]`)[0]);

      expect(routed).toStrictEqual([
        [
          row.navigator,
          ...(row.screen === null ? [] : [{ screen: row.screen }]),
        ],
      ]);
    });
  });
});
