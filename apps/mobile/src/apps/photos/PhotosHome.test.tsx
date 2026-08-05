// Two rules of Photos' home surface that a unit test can hold, both of which
// were broken before issue #711:
//
//  1. SEARCH IS A DESTINATION, AND THE BAND SURVIVES IT (proto:4953-4954).
//     `appBandOn` excludes only the viewer, zoom, video, slideshow and the
//     editor. Search is none of those, so choosing Search must swap the shelf
//     in place — band still up, Search current, the frame's Home capsule still
//     reachable — and must NOT push the `PhotosSearch` route, which had a back
//     chevron and no band at all.
//
//  2. THE GRID IS THE LOADING STATE (§14, proto:3993-4033). While the library
//     opens, the surface paints packed placeholder tiles at the geometry the
//     real rows will take — never a centred sentence the grid then replaces,
//     and the toolbar stays mounted rather than appearing when the data lands.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import PhotosHome from "./PhotosHome";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  timeline: {
    assets: [] as unknown[],
    error: undefined as string | undefined,
    loading: true,
    sections: [] as unknown[],
  },
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
  // Styles arrive as an object, an array, or a nested array; flatten all three
  // down to whichever `position` wins.
  const position = (style: unknown): string | undefined => {
    if (Array.isArray(style)) {
      for (const entry of style) {
        const found = position(entry);
        if (found) return found;
      }
      return undefined;
    }
    const value = (style as { position?: string } | null)?.position;
    return typeof value === "string" ? value : undefined;
  };
  return {
    Alert: { alert: vi.fn<(...args: unknown[]) => void>() },
    Pressable: ({
      accessibilityLabel,
      children,
      onPress,
    }: {
      accessibilityLabel?: string;
      children?: React.ReactNode;
      onPress?: () => void;
    }) =>
      element("button", {
        "aria-label": accessibilityLabel,
        children,
        onClick: onPress,
        type: "button",
      }),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    Text: ({ children }: { children?: React.ReactNode }) =>
      element("span", { children }),
    View: ({
      accessibilityLabel,
      accessibilityRole,
      children,
      style,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      children?: React.ReactNode;
      style?: unknown;
    }) =>
      element("div", {
        "aria-label": accessibilityLabel,
        children,
        // The one style property the layout test is about, surfaced onto the
        // DOM so an absolute band slot cannot come back unnoticed.
        "data-position": position(style),
        role: accessibilityRole,
      }),
    useWindowDimensions: () => ({ height: 800, width: 390 }),
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
  import("expo-haptics"),
  () =>
    ({
      NotificationFeedbackType: { Success: "success" },
      notificationAsync: vi.fn<() => void>(),
      selectionAsync: vi.fn<() => void>(),
    }) as never
);

vi.mock(
  import("expo-notifications"),
  () =>
    ({
      SchedulableTriggerInputTypes: { DATE: "date" },
      getPermissionsAsync: vi.fn<() => Promise<{ granted: boolean }>>(
        async () => ({ granted: false })
      ),
      scheduleNotificationAsync: vi.fn<() => void>(),
    }) as never
);

vi.mock(
  import("../../kit/components/Icon"),
  () =>
    ({
      default: () => null,
    }) as never
);

vi.mock(import("../../kit/components/NativeText"), async () => {
  const ReactModule = await import("react");
  return {
    Text: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("span", {}, children),
    TextInput: () => null,
  } as never;
});

vi.mock(
  import("../../kit/components/status-line"),
  () =>
    ({
      postStatus: vi.fn<(...args: unknown[]) => void>(),
    }) as never
);

vi.mock(
  import("../../kit/hooks/useReplicaQuery"),
  () =>
    ({
      useReplicaQuery: () => ({ rows: [] }),
    }) as never
);

vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({ refresh: vi.fn<() => void>() }),
    }) as never
);

vi.mock(
  import("../../kit/replica/ReplicaStateCard"),
  () =>
    ({
      default: () => null,
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
  import("../../kit/replica/write-outcome"),
  () =>
    ({
      surfaceWriteFailure: vi.fn<(...args: unknown[]) => void>(),
      surfaceWriteOutcome: vi.fn<(...args: unknown[]) => void>(),
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
          line: "#line",
          skel: "#skel",
          text: "#text",
          toneMat: "#mat",
        },
      }),
    }) as never
);

vi.mock(
  import("../../kit/transfer/transfer-consent"),
  () =>
    ({
      hydrateBackupConsent: vi.fn<() => Promise<void>>(async () => undefined),
    }) as never
);

vi.mock(
  import("../../lib/replica/optimistic"),
  () =>
    ({
      optimisticRowId: () => "row",
      optimisticValues: (row: unknown) => row,
    }) as never
);

vi.mock(
  import("../../lib/replica/thumbnail-pack"),
  () =>
    ({
      refreshPinnedThumbnailPack: vi.fn<() => Promise<void>>(
        async () => undefined
      ),
    }) as never
);

vi.mock(
  import("../../lib/upload/media-producer"),
  () =>
    ({
      backupDeviceMedia: vi.fn<(...args: unknown[]) => void>(),
    }) as never
);

vi.mock(
  import("../../storage"),
  () =>
    ({
      Store: {
        hydrate: vi.fn<(key: string, fallback: unknown) => Promise<unknown>>(
          async (_key, fallback) => fallback
        ),
        set: vi.fn<(...args: unknown[]) => void>(),
      },
    }) as never
);

vi.mock(
  import("./photos-backup"),
  () =>
    ({
      inCloudMessage: () => "",
      runBackup: vi.fn<(...args: unknown[]) => void>(),
      useAutomaticPhotoBackup: vi.fn<(...args: unknown[]) => unknown>(),
    }) as never
);

vi.mock(
  import("./photos-rung-store"),
  () =>
    ({
      usePhotosRung: () => [1, vi.fn<() => void>()],
    }) as never
);

// The band is stubbed to its CONTRACT, not to nothing: it must be in the tree,
// it must be told which destination is current, and choosing one must call
// back. If PhotosHome ever stops rendering it on a shelf, this disappears.
vi.mock(import("./PhotosBand"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({
      current,
      onSelect,
    }: {
      current: string;
      onSelect: (key: string) => void;
    }) =>
      ReactModule.createElement(
        "nav",
        { "aria-label": `band:${current}`, "data-testid": "band" },
        ["library", "albums", "people", "search", "more"].map((key) =>
          ReactModule.createElement(
            "button",
            {
              key,
              onClick: () => onSelect(key),
              type: "button",
              "aria-label": `band-${key}`,
            },
            key
          )
        )
      ),
  } as never;
});

vi.mock(
  import("./PhotosCollectionsView"),
  () =>
    ({
      default: () => null,
    }) as never
);

vi.mock(
  import("./PhotosMoreSheet"),
  () =>
    ({
      default: () => null,
    }) as never
);

vi.mock(
  import("./PhotosPeopleView"),
  () =>
    ({
      default: () => null,
    }) as never
);

vi.mock(import("./PhotosSearch"), async () => {
  const ReactModule = await import("react");
  return {
    default: () => null,
    PhotosSearchView: () =>
      ReactModule.createElement("div", { "data-testid": "search-view" }),
  } as never;
});

vi.mock(import("./PhotosToolbar"), async () => {
  const ReactModule = await import("react");
  return {
    default: () =>
      ReactModule.createElement("div", { "data-testid": "toolbar" }),
  } as never;
});

vi.mock(import("./PhotoTimeline"), async () => {
  const ReactModule = await import("react");
  return {
    default: () =>
      ReactModule.createElement("div", { "data-testid": "timeline" }),
  } as never;
});

vi.mock(
  import("./pinned-thumbnails"),
  () =>
    ({
      pinnedThumbnailCandidates: () => [],
      pinnedThumbnailSignature: () => "sig",
    }) as never
);

vi.mock(
  import("./timeline-model"),
  () =>
    ({
      onThisDay: () => [],
    }) as never
);

vi.mock(
  import("./timeline-source"),
  () =>
    ({
      usePhotoTimeline: () => mocks.timeline,
    }) as never
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

type HomeProps = React.ComponentProps<typeof PhotosHome>;

/** `route` is never read by this screen; the navigator supplies it. */
function props(navigate: () => void): HomeProps {
  return { navigation: { navigate }, route: {} } as unknown as HomeProps;
}

function render(): void {
  act(() => {
    root = createRoot(container!);
    root.render(<PhotosHome {...props(vi.fn<() => void>())} />);
  });
}

function press(label: string): void {
  const button = container!.querySelector(`button[aria-label="${label}"]`);
  expect(button).toBeTruthy();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("PhotosHome behavior", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.timeline.loading = true;
    mocks.timeline.assets = [];
    mocks.timeline.sections = [];
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  describe("Search is a destination and the band survives it", () => {
    it("swaps the shelf in place and keeps the band up, with Search current", () => {
      render();
      press("band-search");
      expect(
        container!.querySelector('[data-testid="search-view"]')
      ).toBeTruthy();
      const band = container!.querySelector('[data-testid="band"]');
      expect(band).toBeTruthy();
      expect(band!.getAttribute("aria-label")).toBe("band:search");
    });

    it("never pushes the PhotosSearch route", () => {
      const navigate = vi.fn<() => void>();
      act(() => {
        root = createRoot(container!);
        root.render(<PhotosHome {...props(navigate)} />);
      });
      press("band-search");
      expect(navigate).not.toHaveBeenCalledWith("PhotosSearch");
    });
  });

  describe("the grid is the loading state", () => {
    it("paints packed placeholder tiles, not a sentence", () => {
      render();
      const skeleton = container!.querySelector(
        '[role="progressbar"][aria-label="Opening your library"]'
      );
      expect(skeleton).toBeTruthy();
      // Packed rows of real tiles, at real geometry — not one empty box.
      expect(skeleton!.querySelectorAll("div div").length).toBeGreaterThan(10);
      expect(container!.textContent).not.toContain("Opening your library…");
    });

    it("keeps the toolbar mounted while the library opens", () => {
      render();
      expect(container!.querySelector('[data-testid="toolbar"]')).toBeTruthy();
    });

    it("gives way to the timeline once the sections land", () => {
      mocks.timeline.loading = false;
      mocks.timeline.sections = [{ day: "2026-07-30" }];
      render();
      expect(container!.querySelector('[data-testid="timeline"]')).toBeTruthy();
      expect(
        container!.querySelector('[aria-label="Opening your library"]')
      ).toBeNull();
    });
  });

  // THE BUG THIS HOLDS SHUT (§G, handoff `appBandStyle` :4955). The band used to
  // be an absolutely positioned slot at `bottom: 0` over the shelf, with each
  // scroll surface padding its own content by the band's height to compensate.
  // Padding only guarantees the END of the content clears the band: mid-scroll,
  // a day header ("Fri, 31 Jul") and a tile caption still rendered underneath it.
  // The handoff makes the band a `flex:none` SIBLING below the scroll region, so
  // the viewport is genuinely shorter and there is no "under" to pass through.
  describe("the band is a sibling of the shelf, not an overlay on it", () => {
    /** Every `position` an element inherits from its ancestors, frame included. */
    function positionsUpFrom(node: HTMLElement): (string | undefined)[] {
      const chain: (string | undefined)[] = [];
      let cursor: HTMLElement | null = node;
      while (cursor && cursor !== container) {
        chain.push(cursor.dataset.position);
        cursor = cursor.parentElement;
      }
      return chain;
    }

    function renderWithTimeline(): { band: HTMLElement; slot: HTMLElement } {
      mocks.timeline.loading = false;
      mocks.timeline.sections = [{ day: "2026-07-30" }];
      render();
      const band = container!.querySelector<HTMLElement>(
        '[data-testid="band"]'
      )!;
      // The shelf's slot is the `flex: 1` View the timeline is rendered into.
      const slot = container!.querySelector(
        '[data-testid="timeline"]'
      )!.parentElement!;
      return { band, slot };
    }

    it("renders the band after the shelf, under the same parent", () => {
      const { band, slot } = renderWithTimeline();
      expect(band.parentElement).toBe(container!.firstElementChild);
      expect(slot.parentElement).toBe(container!.firstElementChild);
      expect(slot.nextElementSibling).toBe(band);
    });

    it("SABOTAGE: no absolutely positioned band slot survives", () => {
      const { band, slot } = renderWithTimeline();
      // An absolute ancestor takes the band out of flow, the slot grows back to
      // the full height, and the grid scrolls under the bar again.
      expect(positionsUpFrom(band)).not.toContain("absolute");
      expect(positionsUpFrom(slot)).not.toContain("absolute");
    });
  });
});
