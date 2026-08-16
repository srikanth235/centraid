// @vitest-environment jsdom
// The Places map on the phone (issue #781).
//
// `place-map.test.ts` owns the projection — the pixels, the graticule, the
// scale bar, the pixel merge — and none of that is restated here. What this
// file owns is the seat around it, which no cheaper layer can falsify:
//
//   1. THE HEAD STATES THE MAP'S OWN SIZE: how many geotagged photographs are
//      drawn, out of how many the library holds. Two different numerators, so
//      a screen that printed the library count twice would look right and say
//      nothing.
//   2. A PIN IS A CONTROL IN THE ACCESSIBILITY TREE. The pins are real
//      `Pressable`s stacked over the SVG rather than `onPress` on an SVG
//      shape, precisely so a screen reader has something to land on; a
//      regression back to SVG press handling would leave a map nobody who
//      cannot see it can read.
//   3. A PIN IS THE PHOTOGRAPH taken there. The first cut drew dots on a
//      graticule labelled in degrees, which is a chart, not a map.
//   4. READING A PIN CHANGES THE READOUT, and reading a second one replaces
//      the first — one place is being read at a time, not a growing list.
//   5. THE MAP FETCHES NOTHING. This screen used to draw `MapView` from
//      `react-native-maps`, which asks the OS map vendor for the
//      neighbourhoods a member photographed — the only place in the product
//      where looking at your own library told a third party anything.
//
// Same react-native-as-DOM technique as `FaceReview.test.tsx`; the production
// component, its pure model and the shared projection all stay real.
import { readFileSync } from "node:fs";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makePhotosFixture } from "./photos-fixtures";
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
    onStage: "#mock-on-stage",
    stage: "#mock-stage",
    text: "#mock-text",
    textFaint: "#mock-text-faint",
    textSoft: "#mock-text-soft",
  },
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
    Image: ({ source }: { source?: { uri?: string } }) =>
      element("img", { alt: "", src: source?.uri }),
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
// the geometry it would be handed is the projection's, and owned there.
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
  import("../../kit/replica/ReplicaStatusBar"),
  () =>
    ({
      default: () => null,
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

function pins(): HTMLButtonElement[] {
  return Array.from(container!.querySelectorAll("button")).filter(
    (button) => button.getAttribute("aria-label") !== "Back to Photos"
  );
}

function press(button: Element | undefined): void {
  expect(button).toBeDefined();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("the Places map (native)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.places = PLACE_ROWS;
    // Three geotagged photographs across two places, plus one the library
    // holds that carries no place at all.
    mocks.assets = [
      TAHOE_PHOTO,
      { ...TAHOE_PHOTO, id: "place-tahoe-2" },
      HOME_PHOTO,
      UNPLACED_PHOTO,
    ];
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
});

describe("the Places map's silence", () => {
  it("draws no basemap, so opening Places asks no map vendor anything", () => {
    // Asserted against the SOURCE because that is where the regression would
    // land: a rendered tree proves only that the seam this file mocked was
    // not called, while a re-added `react-native-maps` import is the whole
    // defect — the screen would look correct and emit on a real device.
    // Located from this file's own path — under jsdom `import.meta.url` is an
    // http URL, and a cwd-relative path would depend on which config invoked
    // the project.
    const source = readFileSync(
      expect.getState().testPath!.replace(/\.test\.tsx$/u, ".tsx"),
      "utf8"
    );
    expect(source).not.toMatch(/from\s+["']react-native-maps["']/u);
  });
});
