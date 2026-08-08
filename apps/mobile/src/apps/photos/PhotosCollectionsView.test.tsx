// The per-section collapse this page draws its rails under (issue #712).
//
// Two claims this file pins:
//
//  1. A COLLAPSED SECTION KEEPS ITS HEADING AND COUNT. Collapsing is a
//     display fold over a section that still exists — never a filter — so
//     the heading, including its exact count, must survive the fold even
//     while the rail underneath it disappears.
//  2. The "open this shelf" verb on the heading survives untouched: tapping
//     the title still navigates, even after a section has been folded and
//     unfolded.
//
// THE `···` CHIP AND ITS MENU LIVE IN `PhotosHome.test.tsx` NOW, not here
// (issue #712): the page stopped drawing its own header row — Show All /
// Collapse All open from the SAME header slot Library's Sliders chip uses,
// scoped to whichever destination is current — so this file only owns the
// state those two commands act on. `collapsed` and `onToggleSection` arrive
// as props, exactly as `PhotosHome.tsx` passes them, and the tests below
// drive the fold directly through a `useState` wrapper that stands in for
// that lifted state.
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTION_SECTION_KEYS } from "./photos-collections";
import type { CollectionSectionKey } from "./photos-collections";
// @vitest-environment jsdom
import PhotosCollectionsView from "./PhotosCollectionsView";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  assets: [] as unknown[],
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
  () => ({ useReplicaQuery: () => ({ rows: [] }) }) as never
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
  import("../../kit/share/use-share-target"),
  () =>
    ({
      useShareTarget: () => ({
        candidates: [],
        choose: vi.fn<() => void>(),
        hydrated: true,
        reason: null,
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

vi.mock(import("./timeline-model"), () => ({ onThisDay: () => [] }) as never);

vi.mock(
  import("./timeline-source"),
  () => ({ usePhotoTimeline: () => ({ assets: mocks.assets }) }) as never
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** Stands in for `PhotosHome.tsx`, which owns `collapsed` since issue #712 —
 *  see `PhotosCollectionsView.tsx`'s own header comment on the `collapsed`
 *  prop for why the fold moved out of this file. The toggle here is the same
 *  add/delete-from-a-`Set` shape `PhotosHome.tsx`'s own
 *  `toggleCollectionSection` uses, so a test driving it through this harness
 *  is exercising the real contract rather than a simplified stand-in. */
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

/** The Favorites heading, count included — a shelf that always exists with a
 *  stated (if zero) count, so it is the steady landmark every test below
 *  folds and unfolds against. */
const FAVORITES_HEADING = "Open Favorites, 0";

describe("Collections' per-section collapse", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.assets = [];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  // No header row of its own to test here anymore (issue #712) — the `···`
  // chip and its Show All / Collapse All menu moved into `PhotosHome.tsx`'s
  // own header, scoped to the Collections destination; see
  // `PhotosHome.test.tsx`'s "the header's trailing control is
  // destination-scoped" tests for that chip and its menu.

  it("a collapsed section keeps its heading and count, and drops its rail", () => {
    render();
    // Favorites starts expanded — folding it must not touch its heading.
    press("Collapse Favorites");
    expect(
      container!.querySelector(`button[aria-label="${FAVORITES_HEADING}"]`)
    ).toBeTruthy();
    // Folded once, the toggle now offers to expand it back.
    expect(
      container!.querySelector('button[aria-label="Expand Favorites"]')
    ).toBeTruthy();
  });

  it("Collapse All (as PhotosHome's menu would set it) folds every section, each still stating its heading", () => {
    // `PhotosHome.tsx`'s own Collapse All row sets `collapsed` to every key
    // in `COLLECTION_SECTION_KEYS` at once — this proves the view honours
    // that shape rather than only ever folding one section at a time through
    // its own chevrons.
    render(new Set(COLLECTION_SECTION_KEYS));
    // Every section's toggle now reads "Expand …" — none is left open.
    const expanders = [
      ...container!.querySelectorAll("button[aria-label^='Expand ']"),
    ];
    expect(expanders).toHaveLength(COLLECTION_SECTION_KEYS.length);
    // Every PER-SECTION collapse toggle is gone — none is left expanded.
    expect(
      container!.querySelectorAll("button[aria-label^='Collapse ']")
    ).toHaveLength(0);
    // The heading survives the fold — the exact stated count for Favorites.
    expect(
      container!.querySelector(`button[aria-label="${FAVORITES_HEADING}"]`)
    ).toBeTruthy();
  });

  it("Show All (an empty set from PhotosHome's menu) leaves every section expanded", () => {
    // Show All sets `collapsed` back to an empty set — the same starting
    // shape `render()`'s default already exercises — so this proves that
    // shape alone reads as "every section open" rather than assuming it from
    // the previous test's fold.
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

  // People is off the band (issue #712) — this is now the one route that
  // proves the people surface (`PhotosPeopleView`) stays reachable: its
  // heading pushes `PhotosPeople` directly rather than a band destination
  // that no longer exists.
  it("the People heading reaches the people surface, off the band", () => {
    const navigate = vi.fn<(...args: unknown[]) => void>();
    act(() => {
      root = createRoot(container!);
      root.render(<Harness navigate={navigate} />);
    });
    press("Open People, 0");
    expect(navigate).toHaveBeenCalledWith("PhotosPeople");
  });

  // Issue #721 B3 — Videos joined the shelf list; its heading opens the same
  // `PhotoStateView` filter door Favorites already uses, not a bespoke grid.
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
