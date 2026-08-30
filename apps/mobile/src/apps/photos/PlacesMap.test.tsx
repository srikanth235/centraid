// @vitest-environment jsdom
// The Places map seat (#781, #816); the projection is `place-map.test.ts`'s.
// The claims here: the head states drawn-of-held, a pin is a real control in the
// accessibility tree AND the photograph taken there, reading a pin REPLACES the
// readout, and egress is mode-shaped — no map SDK is constructed on the private
// sketch, and with real maps on only the base layer's style is fetched. Both
// halves are asserted; dropping the first because a basemap arrived is the
// regression. The SDKs are mocked as RECORDERS, which is what makes "no map view
// was constructed" falsifiable.
import { readFileSync } from "node:fs";
import path from "node:path";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makePhotosFixture } from "./photos-fixtures";
import { DEFAULT_PLACES_MAP_MODE, setMapMode } from "./places-map-mode";
import PlacesMap from "./PlacesMap";

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
    accent: "#mock-accent",
    bg: "#mock-bg",
    bgElev: "#mock-bg-elev",
    bgSunken: "#mock-bg-sunken",
    line: "#mock-line",
    net: "#mock-net",
    onStage: "#mock-on-stage",
    stage: "#mock-stage",
    text: "#mock-text",
    textFaint: "#mock-text-faint",
    textSoft: "#mock-text-soft",
  },
  /** Empty is the whole claim on the private sketch. */
  mapViews: [] as Record<string, unknown>[],
  menus: [] as unknown[],
  places: [] as unknown[],
  stored: new Map<string, unknown>(),
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
    ActivityIndicator: () => null,
    Image: ({ source }: { source?: { uri?: string } }) =>
      element("img", { alt: "", src: source?.uri }),
    Platform: { OS: "android" },
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
    StyleSheet: { absoluteFill: {}, create: <T,>(styles: T): T => styles },
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

// `react-native-svg` has no DOM implementation; its geometry is the projection's.
vi.mock(import("react-native-svg"), async () => {
  const ReactModule = await import("react");
  const passthrough = (tag: string) => {
    const Host = ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(tag, null, children);
    Host.displayName = `${tag}Mock`;
    return Host;
  };
  return {
    default: passthrough("div"),
    G: passthrough("div"),
    Line: () => null,
    Text: passthrough("span"),
  } as never;
});

// THE MAP SDK, AS A RECORDER: constructing a map view has to be observable.
vi.mock(import("@maplibre/maplibre-react-native"), async () => {
  const ReactModule = await import("react");
  return {
    Camera: () => null,
    Map: (props: Record<string, unknown>) => {
      mocks.mapViews.push(props);
      return ReactModule.createElement(
        "div",
        { "data-map": String(props["mapStyle"]) },
        props["children"] as React.ReactNode
      );
    },
    Marker: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
  } as never;
});

vi.mock(
  import("react-native-safe-area-context"),
  () =>
    ({
      useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
    }) as never
);

vi.mock(
  import("../../kit/components/Icon"),
  () =>
    ({
      default: () => null,
    }) as never
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
  import("../../kit/components/AnchoredMenu"),
  () =>
    ({
      default: (props: { visible: boolean; groups: unknown }) => {
        if (props.visible) mocks.menus.push(props.groups);
        return null;
      },
      useMenuAnchor: () => ({
        anchor: undefined,
        anchorRef: { current: null },
        measureAnchor: () => undefined,
      }),
    }) as never
);

vi.mock(
  import("../../kit/replica/ReplicaStatusBar"),
  () =>
    ({
      default: () => null,
    }) as never
);

vi.mock(
  import("../../storage"),
  () =>
    ({
      Store: {
        hydrate: async (key: string, fallback: unknown) =>
          mocks.stored.has(key) ? mocks.stored.get(key) : fallback,
        set: (key: string, value: unknown) => {
          mocks.stored.set(key, value);
        },
      },
    }) as never
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
      useReplicaQuery: (): { rows: unknown[] } => ({ rows: mocks.places }),
    }) as unknown as Partial<UseReplicaQueryModule>
);

vi.mock(
  import("./timeline-source"),
  () =>
    ({
      usePhotoTimeline: () => ({ assets: mocks.assets }),
    }) as unknown as Partial<TimelineSourceModule>
);

const [TAHOE_PHOTO, HOME_PHOTO] = makePhotosFixture("place-tagged").assets;
const [UNPLACED_PHOTO] = makePhotosFixture("one-day").assets;
const PLACE_ROWS = [
  {
    place_id: "place-tahoe",
    name: "Lake Tahoe",
    geo_lat: 39.096_8,
    geo_lng: -120.032_4,
  },
  { place_id: "place-home", name: "Home", geo_lat: 37.44, geo_lng: -122.14 },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let goBack: ReturnType<typeof vi.fn<() => void>>;

function renderMap(): void {
  goBack = vi.fn<() => void>();
  act(() => {
    root = createRoot(container!);
    root.render(
      <PlacesMap navigation={{ goBack } as never} route={{} as never} />
    );
  });
}

/** Awaits the lazily-imported provider: two microticks suffice only on an idle
 *  worker, and a coverage run compiling that graph is not idle. */
async function renderRealMap(): Promise<void> {
  renderMap();
  await act(async () => {
    await import("./places-map-libre");
  });
}

function pins(): HTMLButtonElement[] {
  const chrome = new Set(["Back to Photos", "Map mode"]);
  return Array.from(container!.querySelectorAll("button")).filter(
    (button) => !chrome.has(button.getAttribute("aria-label") ?? "")
  );
}

function press(button: Element | undefined): void {
  expect(button).toBeDefined();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** Under jsdom `import.meta.url` is an http URL, so read the test path instead. */
const here = path.dirname(expect.getState().testPath ?? "");
const source = (file: string): string =>
  readFileSync(path.join(here, file), "utf8");

describe("the Places map (native)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.mapViews = [];
    mocks.menus = [];
    mocks.stored.clear();
    mocks.places = PLACE_ROWS;
    // Three geotagged across two places, plus one the library holds unplaced.
    mocks.assets = [
      TAHOE_PHOTO,
      { ...TAHOE_PHOTO, id: "place-tahoe-2" },
      HOME_PHOTO,
      UNPLACED_PHOTO,
    ];
    setMapMode("sketch");
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    mocks.mapViews = [];
    mocks.menus = [];
    setMapMode(DEFAULT_PLACES_MAP_MODE);
  });

  it("states how many photographs are drawn out of how many the library holds", () => {
    renderMap();
    expect(container!.textContent).toContain("3 of 4");
  });

  it("gives every place a pin a screen reader can land on", () => {
    renderMap();
    expect(pins().map((pin) => pin.getAttribute("aria-label"))).toStrictEqual([
      "Lake Tahoe, 2 photographs",
      "Home, 1 photograph",
    ]);
  });

  it("draws each pin as a photograph taken there", () => {
    renderMap();
    expect(
      Array.from(container!.querySelectorAll("img")).map((image) =>
        image.getAttribute("src")
      )
    ).toStrictEqual([TAHOE_PHOTO!.uri, HOME_PHOTO!.uri]);
  });

  it("reads out the place whose pin was pressed", () => {
    renderMap();
    press(pins()[1]);
    expect(container!.textContent).toContain("Home · 1");
  });

  it("replaces the readout when a second pin is pressed, never appending", () => {
    renderMap();
    press(pins()[1]);
    press(pins()[0]);
    expect(container!.textContent).toContain("Lake Tahoe · 2");
    expect(container!.textContent).not.toContain("Home · 1");
  });

  it("says at rest that the map is plotted from the member's own photographs", () => {
    renderMap();
    expect(container!.textContent).toContain(
      "Plotted from your own photographs."
    );
  });

  it("says a place is something a photograph carries when nothing is plottable", () => {
    mocks.assets = [UNPLACED_PHOTO];
    renderMap();
    expect(container!.textContent).toContain(
      "No places yet — a photograph lands here once it carries where it was taken."
    );
    expect(pins()).toStrictEqual([]);
  });

  it("leaves the map by its one exit", () => {
    renderMap();
    press(
      Array.from(container!.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Back to Photos"
      )
    );
    expect(goBack).toHaveBeenCalledOnce();
  });

  it("offers the two maps as one answered question, and switches to the other", () => {
    setMapMode("real");
    renderMap();
    press(
      Array.from(container!.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Map mode"
      )
    );
    const rows = (
      mocks.menus.at(-1) as Array<{
        rows: Array<{ checked: boolean; label: string; onSelect: () => void }>;
      }>
    )[0]!.rows;
    // Two rows, one checked: "this is the answer, here is the other one".
    expect(rows.map((row) => [row.label, row.checked])).toStrictEqual([
      ["Real maps", true],
      ["Private sketch", false],
    ]);
    act(() => rows[1]!.onSelect());
    expect(mocks.mapViews).toStrictEqual([]);
    expect(container!.textContent).toContain(
      "Nothing is fetched — this map is drawn here from your own coordinates."
    );
  });

  it("draws the real map by default and the sketch only when asked", async () => {
    // Real-maps-on is the ruling (P-cartography); exercising only the sketch
    // would let the default rot.
    setMapMode("real");
    await renderRealMap();
    expect(mocks.mapViews).toHaveLength(1);
    act(() => root?.unmount());
    mocks.mapViews = [];
    setMapMode("sketch");
    renderMap();
    expect(mocks.mapViews).toStrictEqual([]);
  });
});

describe("what the Places map asks of anybody, per mode", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.mapViews = [];
    mocks.stored.clear();
    mocks.places = PLACE_ROWS;
    mocks.assets = [TAHOE_PHOTO, HOME_PHOTO];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    mocks.mapViews = [];
    mocks.menus = [];
    setMapMode(DEFAULT_PLACES_MAP_MODE);
  });

  it("constructs no map view at all on the private sketch", () => {
    // Asserted on the SDK, not the markup: a map view rendering nothing visible
    // still fetches tiles on a real device.
    setMapMode("sketch");
    renderMap();
    expect(mocks.mapViews).toStrictEqual([]);
    expect(container!.textContent).toContain(
      "Nothing is fetched — this map is drawn here from your own coordinates."
    );
  });

  it("fetches only the base layer's style with real maps on", async () => {
    setMapMode("real");
    await renderRealMap();
    expect(mocks.mapViews.map((props) => props["mapStyle"])).toStrictEqual([
      "https://tiles.openfreemap.org/styles/liberty",
    ]);
  });

  it("hands the map SDK nothing the library holds", async () => {
    setMapMode("real");
    await renderRealMap();
    // The SDK is entitled to a viewport and nothing else: this app draws the
    // pins over the base layer itself.
    const handed = mocks.mapViews.flatMap((props) =>
      Object.entries(props)
        .filter(([key]) => key !== "children")
        // Handlers stringify to `undefined`; only data is being read.
        .map(([, value]) => JSON.stringify(value) ?? "")
    );
    for (const value of handed) {
      expect(value).not.toContain(TAHOE_PHOTO!.uri);
      expect(value).not.toContain("Lake Tahoe");
    }
    expect(container!.textContent).toContain(
      "The map provider sees which areas you open — no photograph, name or phrase ever leaves this device."
    );
  });

  it("credits OpenStreetMap on the map that draws its data", async () => {
    setMapMode("real");
    await renderRealMap();
    expect(container!.textContent).toContain("© OpenStreetMap contributors");
  });

  it("keeps the private sketch free of every map SDK, in the source", () => {
    // Asserted against the SOURCE: a mocked seam proves nothing about an SDK
    // imported into the sketch. Only the two providers may name one.
    for (const file of ["PlacesSketchMap.tsx", "PlacesMap.tsx"]) {
      expect(source(file)).not.toMatch(
        /from\s+["'](?:expo-maps|@maplibre\/[^"']+|react-native-maps)["']/u
      );
    }
  });

  it("publishes an accessible control over every real MapKit pin", () => {
    const apple = source("places-map-apple.tsx");
    expect(apple).toContain("accessibilityLabel={pinLabel(pin)}");
    expect(apple).toContain("onPress={() => onRead(pin)}");
  });

  it("names exactly one remote host across the whole map surface", () => {
    // Any second URL in these files is a second thing fetched — the egress claim
    // breaking.
    const urls = [
      "PlacesMap.tsx",
      "PlacesSketchMap.tsx",
      "PlacesRealMap.tsx",
      "places-map-apple.tsx",
      "places-map-libre.tsx",
      "places-pin.tsx",
    ].flatMap((file) => source(file).match(/https?:\/\/[^\s"'`)]+/gu) ?? []);
    expect(urls).toStrictEqual([
      "https://tiles.openfreemap.org/styles/liberty",
    ]);
  });
});
