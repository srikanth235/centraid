// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTION_SECTION_KEYS } from "./photos-collections";
import type { CollectionSectionKey } from "./photos-collections";
import { makePhotosFixture } from "./photos-fixtures";
import PhotosCollectionsView from "./PhotosCollectionsView";
import PlaceDetail from "./PlaceDetail";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  assets: [] as unknown[],
  places: [] as unknown[],
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const element = (
    tag: string,
    elementProps: Record<string, unknown> & { children?: React.ReactNode } = {}
  ): React.JSX.Element => {
    const { children, ...rest } = elementProps;
    return ReactModule.createElement(tag, rest, children);
  };
  return {
    Pressable: ReactModule.forwardRef(
      (
        {
          accessibilityLabel,
          accessibilityState,
          children,
          onPress,
        }: {
          accessibilityLabel?: string;
          accessibilityState?: { expanded?: boolean };
          children?: React.ReactNode;
          onPress?: () => void;
        },
        ref: React.Ref<unknown>
      ) =>
        element("button", {
          "aria-expanded": accessibilityState?.expanded,
          "aria-label": accessibilityLabel,
          children,
          onClick: onPress,
          ref,
          type: "button",
        })
    ),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    Text: ({ children }: { children?: React.ReactNode }) =>
      element("span", { children }),
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as never;
});

vi.mock(import("expo-image"), () => ({ Image: () => null }) as never);

vi.mock(
  import("../../kit/components/Icon"),
  () => ({ default: () => null }) as never
);

vi.mock(import("../../kit/components/NativeText"), async () => {
  const ReactModule = await import("react");
  return {
    Text: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("span", {}, children),
  } as never;
});

vi.mock(
  import("../../kit/hooks/useReplicaQuery"),
  () =>
    ({
      useReplicaQuery: (
        _appId: string,
        query: { entity?: string }
      ): { rows: unknown[] } => ({
        rows: query.entity === "core.place" ? mocks.places : [],
      }),
    }) as never
);

vi.mock(
  import("../../kit/media/use-image-fallback"),
  () =>
    ({
      useImageFallback: () => ({
        decoded: false,
        failed: false,
        handleError: vi.fn<() => void>(),
        handleLoad: vi.fn<() => void>(),
        recyclingKey: "k",
        source: "",
      }),
    }) as never
);

vi.mock(
  import("../../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      pageMargin: 18,
      spacing: Array.from({ length: 8 }, (_, index) => index * 4),
      t: () => ({}),
      useTheme: () => ({
        colors: {
          bgSunken: "#sunk",
          line: "#line",
          lineStrong: "#lineStrong",
          onAccent: "#onAccent",
          scrim: "#scrim",
          skel: "#skel",
          text: "#text",
          textFaint: "#faint",
          textSoft: "#soft",
        },
      }),
    }) as never
);

vi.mock(import("./timeline-model"), async (importOriginal) => ({
  ...(await importOriginal()),
  onThisDay: () => [],
}));

vi.mock(
  import("../../kit/replica/ReplicaStatusBar"),
  () => ({ default: () => null }) as never
);

vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () => ({ useReplica: () => ({ session: undefined }) }) as never
);

vi.mock(
  import("../../kit/replica/write-outcome"),
  () =>
    ({
      surfaceWriteFailure: () => undefined,
      surfaceWriteOutcome: () => true,
    }) as never
);

vi.mock(
  import("../../kit/replica/useReplicaRefresh"),
  () =>
    ({
      useReplicaRefresh: () => ({
        refreshing: false,
        refreshNow: () => undefined,
      }),
    }) as never
);

vi.mock(import("./PhotoTimeline"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({ sections }: { sections: Array<{ assets: unknown[] }> }) =>
      ReactModule.createElement(
        "div",
        { "data-testid": "place-photographs" },
        sections.flatMap((section) => section.assets).length
      ),
  } as never;
});

vi.mock(import("./PhotosScreen"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  } as never;
});

vi.mock(
  import("./timeline-source"),
  () => ({ usePhotoTimeline: () => ({ assets: mocks.assets }) }) as never
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function Harness({
  navigate,
  initialCollapsed,
}: {
  navigate: (...args: unknown[]) => void;
  initialCollapsed?: ReadonlySet<CollectionSectionKey>;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<CollectionSectionKey>>(
    () => initialCollapsed ?? new Set()
  );
  const onToggleSection = (key: CollectionSectionKey): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <PhotosCollectionsView
      navigation={{ navigate } as never}
      collapsed={collapsed}
      onToggleSection={onToggleSection}
    />
  );
}

function TileToDetailHarness(): React.JSX.Element {
  const [detail, setDetail] = useState<{
    placeKey: string;
    placeName: string;
  } | null>(null);
  const navigate = (screen: string, params?: Record<string, unknown>): void => {
    if (screen !== "PlaceDetail") return;
    setDetail(params as { placeKey: string; placeName: string });
  };
  return detail ? (
    <PlaceDetail
      navigation={{ goBack: () => setDetail(null), navigate } as never}
      route={{ params: detail } as never}
    />
  ) : (
    <PhotosCollectionsView
      navigation={{ navigate } as never}
      collapsed={new Set()}
      onToggleSection={() => undefined}
    />
  );
}

function render(initialCollapsed?: ReadonlySet<CollectionSectionKey>): void {
  act(() => {
    root = createRoot(container!);
    root.render(
      <Harness
        navigate={vi.fn<(...args: unknown[]) => void>()}
        initialCollapsed={initialCollapsed}
      />
    );
  });
}

function press(label: string): void {
  const button = container!.querySelector(`button[aria-label="${label}"]`);
  expect(button).toBeTruthy();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const FAVORITES_HEADING = "Open Favorites, 0";

describe("Collections' per-section collapse", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.assets = [];
    mocks.places = [];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("a collapsed section keeps its heading and count, and drops its rail", () => {
    render();
    press("Collapse Favorites");
    expect(
      container!.querySelector(`button[aria-label="${FAVORITES_HEADING}"]`)
    ).toBeTruthy();
    expect(
      container!.querySelector('button[aria-label="Expand Favorites"]')
    ).toBeTruthy();
  });

  it("Collapse All (as PhotosHome's menu would set it) folds every section, each still stating its heading", () => {
    render(new Set(COLLECTION_SECTION_KEYS));
    const expanders = [
      ...container!.querySelectorAll("button[aria-label^='Expand ']"),
    ];
    expect(expanders).toHaveLength(COLLECTION_SECTION_KEYS.length);
    expect(
      container!.querySelectorAll("button[aria-label^='Collapse ']")
    ).toHaveLength(0);
    expect(
      container!.querySelector(`button[aria-label="${FAVORITES_HEADING}"]`)
    ).toBeTruthy();
  });

  it("Show All (an empty set from PhotosHome's menu) leaves every section expanded", () => {
    render(new Set());
    expect(
      container!.querySelectorAll("button[aria-label^='Expand ']")
    ).toHaveLength(0);
    expect(
      container!.querySelector('button[aria-label="Collapse Favorites"]')
    ).toBeTruthy();
  });

  it("the heading keeps its own verb — opening the shelf — after a fold", () => {
    const navigate = vi.fn<(...args: unknown[]) => void>();
    act(() => {
      root = createRoot(container!);
      root.render(<Harness navigate={navigate} />);
    });
    press("Collapse Favorites");
    press(FAVORITES_HEADING);
    expect(navigate).toHaveBeenCalledWith("PhotoStateView", {
      mode: "favorites",
    });
  });

  it("the People heading reaches the people surface, off the band", () => {
    const navigate = vi.fn<(...args: unknown[]) => void>();
    act(() => {
      root = createRoot(container!);
      root.render(<Harness navigate={navigate} />);
    });
    press("Open People, 0");
    expect(navigate).toHaveBeenCalledWith("PhotosPeople");
  });

  it("a place tile opens the rounded shelf detail with every photograph its count claims", () => {
    const [tahoe] = makePhotosFixture("place-tagged").assets;
    mocks.assets = [tahoe, { ...tahoe, id: "place-tahoe-2" }];
    mocks.places = [
      {
        place_id: "place-tahoe",
        name: "Lake Tahoe",
        geo_lat: 39.096_8,
        geo_lng: -120.032_4,
      },
    ];
    act(() => {
      root = createRoot(container!);
      root.render(<TileToDetailHarness />);
    });

    press("Lake Tahoe");

    expect(container!.textContent).toContain("2 photographs");
    expect(
      container!.querySelector('[data-testid="place-photographs"]')?.textContent
    ).toBe("2");
    expect(container!.textContent).not.toContain(
      "No photographs at Lake Tahoe yet."
    );
  });

  it("labels a place whose only name is its coordinates as unnamed, never the digits", () => {
    const [tahoe] = makePhotosFixture("place-tagged").assets;
    mocks.assets = [tahoe];
    mocks.places = [
      {
        place_id: "place-tahoe",
        name: "39.0968, -120.0324",
        geo_lat: 39.096_8,
        geo_lng: -120.032_4,
      },
    ];
    act(() => {
      root = createRoot(container!);
      root.render(<Harness navigate={vi.fn<(...args: unknown[]) => void>()} />);
    });

    expect(container!.textContent).toContain("A place with no name yet");
    expect(container!.textContent).not.toContain("39.0968, -120.0324");
  });

  it("the Videos heading opens the shared filtered shelf, exactly like Favorites", () => {
    const navigate = vi.fn<(...args: unknown[]) => void>();
    act(() => {
      root = createRoot(container!);
      root.render(<Harness navigate={navigate} />);
    });
    press("Open Videos, 0");
    expect(navigate).toHaveBeenCalledWith("PhotoStateView", {
      mode: "videos",
    });
  });
});
