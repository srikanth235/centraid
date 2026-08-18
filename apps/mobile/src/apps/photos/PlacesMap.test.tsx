// @vitest-environment jsdom
// The Places map on the phone (issues #781, #816).
//
// `place-map.test.ts` owns the projection — the pixels, the graticule, the
// scale bar, the tier-floored merge — and none of that is restated here. What
// this file owns is the seat around it, which no cheaper layer can falsify:
//
//   1. THE HEAD STATES THE MAP'S OWN SIZE: how many geotagged photographs are
//      drawn, out of how many the library holds. Two different numerators, so
//      a screen that printed the library count twice would look right and say
//      nothing.
//   2. A PIN IS A CONTROL IN THE ACCESSIBILITY TREE. The pins are real
//      `Pressable`s rather than `onPress` on an SVG shape or a native marker,
//      precisely so a screen reader has something to land on; a regression
//      back to SVG press handling would leave a map nobody who cannot see it
//      can read.
//   3. A PIN IS THE PHOTOGRAPH taken there. The first cut drew dots on a
//      graticule labelled in degrees, which is a chart, not a map.
//   4. READING A PIN CHANGES THE READOUT, and reading a second one replaces
//      the first — one place is being read at a time, not a growing list.
//   5. WHAT LEAVES THE DEVICE, PER MODE. This is the claim that changed with
//      #816 and it is now mode-shaped rather than absolute. On the private
//      sketch no map SDK is constructed at all: the screen asks nobody
//      anything, which is the same claim this file has always carried. With
//      real maps on, exactly one thing is fetched — the base layer's own style
//      — and nothing the vault holds is ever handed to the SDK. Both halves
//      are asserted; deleting the first half because a basemap arrived would
//      be the regression, not the feature.
//
// Same react-native-as-DOM technique as `FaceReview.test.tsx`; the production
// component, its pure model, the shared projection, the two-mode store and the
// mode-switching frame all stay real. The two map SDKs are mocked because they
// are native host seams with no DOM implementation — and mocking them is what
// makes claim 5 observable: a recording SDK proves whether a map view was ever
// constructed, which a rendered tree alone cannot.
import { readFileSync } from "node:fs";
import path from "node:path";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makePhotosFixture } from "./photos-fixtures";
import { setMapMode } from "./places-map-mode";
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
  /** Every prop object either map SDK's view was constructed with. Empty is
   *  the whole claim on the private sketch. */
  mapViews: [] as Record<string, unknown>[],
  /** The groups the mode menu was opened with, newest last. */
  menus: [] as unknown[],
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

// The one native drawing seam of the sketch. `react-native-svg` has no DOM
// implementation; the geometry it would be handed is the projection's, and
// owned there.
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

// THE MAP SDK, AS A RECORDER. Nothing here draws anything; the point is that
// constructing a map view is observable, so "no map view was constructed" is a
// falsifiable statement about the private sketch rather than a comment.
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

// The menu's own anatomy is `AnchoredMenu`'s to prove; what belongs here is
// WHICH ROWS this screen hands it, and what pressing one does.
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
        hydrate: async (_key: string, fallback: unknown) => fallback,
        set: () => undefined,
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

// Lake Tahoe and a house near Palo Alto — far enough apart that the projection
// keeps them as two pins in any box this screen draws.
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

/** Render and let the real map's lazily-imported provider resolve. Real maps
 *  are the default, so this is the ordinary path. */
async function renderRealMap(): Promise<void> {
  renderMap();
  // Twice: the first flush resolves the dynamic import of the platform's
  // provider, the second renders what it resolved to.
  await act(async () => undefined);
  await act(async () => undefined);
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

/** This file's own directory, so a source read does not depend on which config
 *  invoked the project — under jsdom `import.meta.url` is an http URL. */
const here = path.dirname(expect.getState().testPath ?? "");
const source = (file: string): string =>
  readFileSync(path.join(here, file), "utf8");

describe("the Places map (native)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.mapViews = [];
    mocks.menus = [];
    mocks.places = PLACE_ROWS;
    // Three geotagged photographs across two places, plus one the library
    // holds that carries no place at all.
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
    // A library whose photographs are all unplaced: no pins, no plate, and the
    // shelf's own sentence rather than an empty box.
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
    // Two rows, one of them checked — the menu's whole grammar is "this is the
    // current answer, here is the other one".
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
    // The ruling is real-maps-on (docs/decisions.md, P-cartography), so a
    // member who has never touched the switch gets land under the pins. A test
    // that only ever exercised the sketch would let the default rot.
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
    mocks.places = PLACE_ROWS;
    mocks.assets = [TAHOE_PHOTO, HOME_PHOTO];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("constructs no map view at all on the private sketch", () => {
    // The claim this file has carried since the map stopped drawing
    // `react-native-maps`, kept exactly: with the switch off, opening Places
    // asks no map vendor anything. It is asserted on the SDK rather than on
    // the markup because a map view that renders nothing visible would still
    // be a map view fetching tiles on a real device.
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
    // Every string the SDK was constructed with, flattened. A photograph's
    // URI, a place's name or a search phrase reaching the map view is the
    // defect: the pins are drawn OVER the base layer by this app, so the SDK
    // is entitled to a viewport and nothing else.
    const handed = mocks.mapViews.flatMap((props) =>
      Object.entries(props)
        .filter(([key]) => key !== "children")
        // Handlers stringify to `undefined`; what is being read here is the
        // data, and a callback carries none.
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
    // Asserted against the SOURCE because that is where the regression would
    // land: a rendered tree proves only that the seam this file mocked was not
    // called, while an SDK imported into the sketch is the whole defect — the
    // screen would look correct and emit on a real device. The sketch and the
    // screen that hosts it must both stay clean; the two providers are the
    // only files allowed to name an SDK at all.
    for (const file of ["PlacesSketchMap.tsx", "PlacesMap.tsx"]) {
      expect(source(file)).not.toMatch(
        /from\s+["'](?:expo-maps|@maplibre\/[^"']+|react-native-maps)["']/u
      );
    }
  });

  it("names exactly one remote host across the whole map surface", () => {
    // The base layer's style, once, in the provider that draws it. Any second
    // URL in any of these files is a second thing being fetched, which is the
    // egress claim breaking.
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
