// @vitest-environment jsdom
// The Memories screen's trip block (issue #816) — the phone is the primary
// surface, so this is where "the seeded roll yields the Tahoe trip as a NAMED
// card" is actually checked.
//
// `trips.test.ts` (blueprints) owns the title grammar and the route arithmetic,
// and `memories-model.test.ts` owns the grouping. What this file owns is the
// seat around them, which no cheaper layer can falsify:
//
//   1. THE BLOCK IS HEADED BY A SENTENCE. It used to print the place row's raw
//      name — which is the coordinate `findOrCreatePlaceTx` minted until
//      somebody renames it — or "Away from home" when even that was missing.
//   2. THE TRIP CARRIES A SKETCH. Dots for the stops and a line through them in
//      capture order, from the same projection the Places map runs.
//   3. THE SCREEN FETCHES NOTHING TO DRAW EITHER. No basemap, no tile, no
//      remote URL in the markup this block adds — the sketch is arithmetic over
//      coordinates the vault already holds, so it renders with the network
//      unplugged.
//
// Same react-native-as-DOM technique as `PlacesMap.test.tsx`; the production
// component, the pure model, the phrase ladder and the shared projection all
// stay real.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MemoriesView from "./MemoriesView";
import type { PhotoAsset } from "./timeline-model";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");
type UseReplicaQueryModule = typeof import("../../kit/hooks/useReplicaQuery");
type TimelineSourceModule = typeof import("./timeline-source");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  assets: [] as unknown[],
  colors: {
    bgSunken: "#mock-bg-sunken",
    line: "#mock-line",
    text: "#mock-text",
    textFaint: "#mock-text-faint",
    textSoft: "#mock-text-soft",
  },
  memories: [] as unknown[],
  members: [] as unknown[],
  places: [] as unknown[],
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const element = (
    tag: string,
    props: Record<string, unknown> & { children?: React.ReactNode } = {}
  ): React.JSX.Element => {
    const { children, ...rest } = props;
    return ReactModule.createElement(tag, rest, children);
  };
  return {
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      children,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      children?: React.ReactNode;
      onPress?: () => void;
    }) =>
      element("button", {
        "aria-label": accessibilityLabel,
        children,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      }),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    useWindowDimensions: () => ({
      fontScale: 1,
      height: 844,
      scale: 2,
      width: 390,
    }),
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as unknown as Partial<ReactNative>;
});

// The one native drawing seam. `react-native-svg` has no DOM implementation;
// the shapes keep their geometry as attributes so the sketch's claims are
// checkable, and the geometry itself is owned by `place-map.test.ts`.
vi.mock(import("react-native-svg"), async () => {
  const ReactModule = await import("react");
  return {
    Circle: (props: Record<string, unknown>) =>
      ReactModule.createElement("span", {
        "data-cx": String(props.cx),
        "data-cy": String(props.cy),
        "data-stop": "",
      }),
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", { "data-svg": "" }, children),
    Polyline: (props: Record<string, unknown>) =>
      ReactModule.createElement("span", {
        "data-points": String(props.points),
      }),
  } as never;
});

vi.mock(
  import("../../kit/components/Icon"),
  () => ({ default: () => null }) as never
);

vi.mock(
  import("../../kit/components/NativeText"),
  () =>
    ({
      Text: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("span", {}, children),
    }) as never
);

vi.mock(
  import("../../kit/replica/ReplicaStatusBar"),
  () => ({ default: () => null }) as never
);

// The tiles are not this file's subject and their bytes are a device seam.
vi.mock(import("./PhotoTile"), () => ({ default: () => null }) as never);

vi.mock(
  import("./PhotosScreen"),
  () =>
    ({
      default: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("div", {}, children),
    }) as never
);

vi.mock(
  import("./photos-rung-store"),
  () => ({ usePhotosRung: () => [1, () => undefined] }) as never
);

vi.mock(
  import("./photos-vaults"),
  () => ({ useVaultFacts: () => new Map() }) as never
);

vi.mock(
  import("../../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      radii: { lg: 12, md: 8, pill: 999, sm: 4, xl: 16, xs: 0 },
      spacing: Array.from({ length: 8 }, (_, index) => index * 4),
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors }),
    }) as unknown as Partial<ThemeModule>
);

vi.mock(
  import("../../kit/hooks/useReplicaQuery"),
  () =>
    ({
      useReplicaQuery: (
        _app: string,
        query: { entity: string }
      ): { rows: unknown[] } => {
        if (query.entity === "media.memory") return { rows: mocks.memories };
        if (query.entity === "media.memory_member") {
          return { rows: mocks.members };
        }
        return { rows: mocks.places };
      },
    }) as unknown as Partial<UseReplicaQueryModule>
);

vi.mock(
  import("./timeline-source"),
  () =>
    ({
      usePhotoTimeline: () => ({ assets: mocks.assets }),
    }) as unknown as Partial<TimelineSourceModule>
);

/** The seeded roll's places: a tagged home near Palo Alto, and two away places
 *  the opt-in gazetteer automation has named. */
const PLACE_ROWS = [
  {
    place_id: "place-home",
    name: "Home",
    kind: "home",
    geo_lat: 37.44,
    geo_lng: -122.14,
  },
  {
    place_id: "place-tahoe",
    // Still the label GPS minted — the string a heading must never print.
    name: "39.09680, -120.03240",
    address_json: JSON.stringify({
      gazetteer: { name: "South Lake Tahoe, CA" },
    }),
    geo_lat: 39.0968,
    geo_lng: -120.0324,
  },
  {
    place_id: "place-truckee",
    name: "39.32800, -120.18330",
    address_json: JSON.stringify({ gazetteer: { name: "Truckee, CA" } }),
    geo_lat: 39.328,
    geo_lng: -120.1833,
  },
];

const photo = (
  id: string,
  capturedAt: string,
  placeId?: string
): PhotoAsset => ({
  id,
  assetId: id,
  uri: `file:///rolls/${id}.jpg`,
  previewUri: `file:///rolls/${id}.jpg`,
  originalUri: `file:///rolls/${id}.jpg`,
  capturedAt,
  ...(placeId === undefined ? {} : { placeId }),
  width: 1200,
  height: 800,
  kind: "photo",
  favorite: false,
  archived: false,
  deleted: false,
  backupState: "backed-up",
  source: "replica",
});

// A Saturday and a Sunday away — Truckee on the way up, the lake for the rest,
// and one frame indoors that carries no place at all.
const TRIP_ASSETS = [
  photo("truckee-1", "2026-08-15T09:00:00.000Z", "place-truckee"),
  photo("tahoe-1", "2026-08-15T14:00:00.000Z", "place-tahoe"),
  photo("tahoe-2", "2026-08-16T11:00:00.000Z", "place-tahoe"),
  photo("indoors", "2026-08-16T20:00:00.000Z"),
];

const HOME_ASSETS = Array.from({ length: 5 }, (_, index) =>
  photo(`home-${index}`, `2026-08-0${index + 1}T12:00:00.000Z`, "place-home")
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderMemories(): void {
  act(() => {
    root = createRoot(container!);
    root.render(
      <MemoriesView
        navigation={
          { goBack: () => undefined, navigate: () => undefined } as never
        }
        route={{} as never}
      />
    );
  });
}

describe("a trip on the Memories screen", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.places = PLACE_ROWS;
    mocks.assets = [...TRIP_ASSETS, ...HOME_ASSETS];
    mocks.memories = [
      {
        memory_id: "trip:2026-08-15",
        kind: "trip",
        title_hint: "2-day trip",
        place_id: "place-tahoe",
        started_at: "2026-08-15T09:00:00.000Z",
        ended_at: "2026-08-16T20:00:00.000Z",
      },
    ];
    mocks.members = TRIP_ASSETS.map((asset, ordinal) => ({
      memory_id: "trip:2026-08-15",
      asset_id: asset.id,
      ordinal,
    }));
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("heads the trip with the phrase ladder's sentence", () => {
    renderMemories();
    expect(container!.textContent).toContain("Weekend in South Lake Tahoe, CA");
    expect(container!.textContent).not.toContain("Away from home");
  });

  it("prints neither a coordinate nor a bearing from home", () => {
    renderMemories();
    expect(container!.textContent).not.toMatch(
      /-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+/u
    );
    expect(container!.textContent).not.toMatch(/\bof Home\b/u);
  });

  it("sketches the trip: one dot per stop, one line through them", () => {
    renderMemories();
    const stops = container!.querySelectorAll("[data-stop]");
    expect(stops).toHaveLength(2);
    const line = container!.querySelector("[data-points]");
    // The line passes through the stops it drew, in the order they were
    // photographed — Truckee before the lake.
    expect(
      (line as HTMLElement | null)?.dataset.points?.split(" ")
    ).toStrictEqual(
      Array.from(stops).map((stop) => {
        const { cx, cy } = (stop as HTMLElement).dataset;
        return `${cx},${cy}`;
      })
    );
  });

  it("draws no line for a trip that never left one place", () => {
    mocks.members = [
      { memory_id: "trip:2026-08-15", asset_id: "tahoe-1", ordinal: 0 },
      { memory_id: "trip:2026-08-15", asset_id: "tahoe-2", ordinal: 1 },
    ];
    renderMemories();
    expect(container!.querySelectorAll("[data-stop]")).toHaveLength(1);
    expect(container!.querySelector("[data-points]")).toBeNull();
  });

  it("renders the trip with no remote URL anywhere in its markup", () => {
    renderMemories();
    expect(container!.innerHTML).not.toMatch(/https?:\/\//u);
  });

  it("still shows a trip whose places are unknown to this phone", () => {
    // The place rows have not replicated yet: the block keeps the vault's own
    // hint and simply has no sketch, rather than vanishing.
    mocks.places = [];
    renderMemories();
    expect(container!.textContent).toContain("2-day trip");
    expect(container!.querySelectorAll("[data-stop]")).toHaveLength(0);
  });
});
