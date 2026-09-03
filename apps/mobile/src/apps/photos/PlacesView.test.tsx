import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makePhotosFixture } from "./photos-fixtures";
import PlacesView from "./PlacesView";

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
    skel: "#mock-skel",
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
    FlatList: <T,>({
      data,
      keyExtractor,
      ListEmptyComponent,
      renderItem,
    }: {
      data: readonly T[];
      keyExtractor: (item: T) => string;
      ListEmptyComponent?: React.ReactNode;
      renderItem: (info: { item: T }) => React.ReactNode;
    }) =>
      element("div", {
        children: data.length
          ? data.map((item) =>
              ReactModule.createElement(
                ReactModule.Fragment,
                { key: keyExtractor(item) },
                renderItem({ item })
              )
            )
          : ListEmptyComponent,
      }),
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
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as unknown as Partial<ReactNative>;
});

vi.mock(import("expo-image"), async () => {
  const ReactModule = await import("react");
  return {
    Image: ({ source }: { source?: string }) =>
      ReactModule.createElement("img", { alt: "", src: source }),
  } as never;
});

vi.mock(
  import("../../kit/components/NativeText"),
  () =>
    ({
      Text: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("span", {}, children),
    }) as never
);

vi.mock(
  import("../../kit/media/media-source"),
  () =>
    ({
      imageSource: (uri: string) => uri,
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

vi.mock(import("./PhotosScreen"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  } as never;
});

const [TAHOE_PHOTO, HOME_PHOTO] = makePhotosFixture("place-tagged").assets;
const PLACE_ROWS = [
  {
    place_id: "place-tahoe",
    name: "Lake Tahoe",
    geo_lat: 39.096_8,
    geo_lng: -120.032_4,
  },
  {
    place_id: "place-home",
    name: "Home",
    geo_lat: 37.44,
    geo_lng: -122.14,
  },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let navigate: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

function renderShelf(): void {
  navigate = vi.fn<(...args: unknown[]) => void>();
  act(() => {
    root = createRoot(container!);
    root.render(
      <PlacesView navigation={{ navigate } as never} route={{} as never} />
    );
  });
}

function buttonLabelled(prefix: string): HTMLButtonElement {
  const found = Array.from(container!.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label")?.startsWith(prefix)
  );
  expect(found, `no button labelled ${prefix}`).toBeDefined();
  return found!;
}

describe("the Places shelf, on the phone seat", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.places = PLACE_ROWS;
    mocks.assets = [
      TAHOE_PHOTO,
      { ...TAHOE_PHOTO, id: "place-tahoe-2" },
      HOME_PHOTO,
    ];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("counts places in the head, not the geotagged photographs the map counts", () => {
    renderShelf();
    expect(container!.textContent).toContain("Places · 2");
    expect(container!.textContent).not.toContain("3 of");
  });

  it("labels each card with its place and how many photographs are there", () => {
    renderShelf();
    expect(buttonLabelled("Lake Tahoe").getAttribute("aria-label")).toBe(
      "Lake Tahoe, 2 photographs"
    );
  });

  it("opens the place the tapped card names, not the first one on the shelf", () => {
    renderShelf();
    act(() =>
      buttonLabelled("Home").dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
    expect(navigate).toHaveBeenCalledExactlyOnceWith("PlaceDetail", {
      placeKey: "37.4:-122.1",
      placeName: "Home",
    });
  });

  it("prints a place named only by its coordinates as unnamed, on the card and in its label", () => {
    mocks.places = [
      { ...PLACE_ROWS[0], name: "39.0968, -120.0324" },
      PLACE_ROWS[1],
    ];
    renderShelf();
    expect(container!.textContent).toContain("A place with no name yet");
    expect(container!.textContent).not.toContain("39.0968, -120.0324");
    expect(
      buttonLabelled("A place with no name yet").getAttribute("aria-label")
    ).toBe("A place with no name yet, 2 photographs");
  });

  it("opens the map from the head chip, never a place", () => {
    renderShelf();
    act(() =>
      buttonLabelled("Open map").dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
    expect(navigate).toHaveBeenCalledExactlyOnceWith("PlacesMap");
  });

  it("says a place is something a photograph carries when the shelf is empty", () => {
    mocks.assets = [];
    renderShelf();
    expect(container!.textContent).toContain(
      "No places yet — a place is something a photograph carries, or does not."
    );
    expect(container!.textContent).toContain("Places · 0");
  });

  it("cards the photographs with no place at all, after the places, without counting them as places", () => {
    mocks.assets = [
      ...(mocks.assets as unknown[]),
      { ...(HOME_PHOTO as object), id: "scan", placeId: undefined },
      { ...(HOME_PHOTO as object), id: "screenshot", placeId: undefined },
    ];
    renderShelf();
    expect(buttonLabelled("No location yet").getAttribute("aria-label")).toBe(
      "No location yet, 2 photographs"
    );
    expect(container!.textContent).toContain("Places · 2");
    const labels = Array.from(container!.querySelectorAll("button")).map(
      (button) => button.getAttribute("aria-label")
    );
    expect(labels.at(-1)).toBe("No location yet, 2 photographs");
  });

  it("opens that bucket's own photographs through the reserved key", () => {
    mocks.assets = [
      ...(mocks.assets as unknown[]),
      { ...(HOME_PHOTO as object), id: "scan", placeId: undefined },
    ];
    renderShelf();
    act(() =>
      buttonLabelled("No location yet").dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
    expect(navigate.mock.calls).toStrictEqual([
      [
        "PlaceDetail",
        { placeKey: "no-location", placeName: "No location yet" },
      ],
    ]);
  });

  it("draws a card's cover from the photographs taken there", () => {
    renderShelf();
    expect(
      Array.from(container!.querySelectorAll("img")).map((image) =>
        image.getAttribute("src")
      )
    ).toStrictEqual([TAHOE_PHOTO!.previewUri, HOME_PHOTO!.previewUri]);
  });
});
// @vitest-environment jsdom
