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
//     real rows will take — never a centred sentence the grid then replaces.
//
//  3. A REFUSED GRANT TAKES OVER THE GRID, NOT A MENU ROW (§13; issue #712
//     P13). The timeline never read the OS permission before this: a member
//     who refused the camera-roll prompt got an empty grid with no sentence,
//     and the only surface that said anything was a screen behind the bottom
//     row of the More sheet. The takeover renders in the grid's own slot, and
//     the band stays exactly where it was — the way out is never what a
//     refusal takes away.
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
  // `null` is the frame before the OS has answered — genuinely unknown, and
  // the state the takeover predicate must decline to act on.
  permission: null as null | {
    status: "granted" | "denied" | "undetermined";
    accessPrivileges?: "all" | "limited" | "none";
    canAskAgain: boolean;
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
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
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
  import("expo-media-library"),
  () =>
    ({
      usePermissions: () => [mocks.permission, vi.fn<() => void>()],
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
      family: { sansMedium: "InstrumentSans_500Medium" },
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
      nothingToBackUpMessage: () => "",
      runBackup: vi.fn<(...args: unknown[]) => void>(),
      useAutomaticPhotoBackup: vi.fn<(...args: unknown[]) => unknown>(),
    }) as never
);

// The real store reaches for AsyncStorage through `../../storage`, which does
// not resolve under jsdom. This stand-in keeps the STORE's contract — one
// shared value and the one way to change it — so the menu's View Options rows
// are wired exactly as they are in the app.
vi.mock(import("./photos-rung-store"), async () => {
  const ReactModule = await import("react");
  return {
    usePhotosRung: () => ReactModule.useState(2),
  } as never;
});

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
        ["library", "collections", "search", "more"].map((key) =>
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

// Stubbed to its CONTRACT, same reasoning as `PhotosBand` above: it must
// receive the `collapsed`/`onToggleSection` props PhotosHome now owns
// (issue #712), so a test can prove Home passes them down rather than
// assuming the wiring compiles. The section-by-section fold behaviour those
// props drive is `PhotosCollectionsView.test.tsx`'s own job.
vi.mock(import("./PhotosCollectionsView"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({
      collapsed,
      onToggleSection,
    }: {
      collapsed: ReadonlySet<string>;
      onToggleSection: (key: string) => void;
    }) =>
      ReactModule.createElement("div", {
        "data-collapsed-count": collapsed.size,
        "data-testid": "collections-view",
        onClick: () => onToggleSection("favorites"),
      }),
  } as never;
});

vi.mock(
  import("./PhotosMoreSheet"),
  () =>
    ({
      default: () => null,
    }) as never
);

// Rendered to its CONTRACT, not to nothing (same reasoning as the `PhotosBand`
// stub above): the menu must actually reflect `visible`, and it must render
// the MODEL it was handed, so a test can prove the header chip opens it and
// that the rows PhotosHome built are wired to PhotosHome's own state. The
// card's own behaviour — anchoring, the checkmark, the submenu step and its
// way back — is `kit/components/AnchoredMenu.test.tsx`'s job, so this stub
// flattens both levels into one list of buttons rather than reimplementing it.
vi.mock(import("../../kit/components/AnchoredMenu"), async () => {
  const ReactModule = await import("react");
  interface StubRow {
    key: string;
    label: string;
    checked?: boolean;
    onSelect?: () => void;
    rows?: readonly StubRow[];
  }
  const flatten = (rows: readonly StubRow[]): StubRow[] =>
    rows.flatMap((row) => (row.rows ? flatten(row.rows) : [row]));
  return {
    default: ({
      visible,
      groups,
    }: {
      visible: boolean;
      groups: readonly { key: string; rows: readonly StubRow[] }[];
    }) =>
      visible
        ? ReactModule.createElement(
            "div",
            { "data-testid": "library-menu" },
            groups.flatMap((group) =>
              flatten(group.rows).map((row) =>
                ReactModule.createElement(
                  "button",
                  {
                    key: `${group.key}.${row.key}`,
                    "aria-label": row.label,
                    "aria-selected": row.checked === true ? "true" : "false",
                    onClick: row.onSelect,
                    type: "button",
                  },
                  row.label
                )
              )
            )
          )
        : null,
    useMenuAnchor: () => ({
      anchor: undefined,
      anchorRef: { current: null },
      measureAnchor: vi.fn<() => void>(),
    }),
  } as never;
});

vi.mock(import("./PhotosSearch"), async () => {
  const ReactModule = await import("react");
  return {
    default: () => null,
    PhotosSearchView: () =>
      ReactModule.createElement("div", { "data-testid": "search-view" }),
  } as never;
});

vi.mock(import("./PhotoTimeline"), async () => {
  const ReactModule = await import("react");
  return {
    // `sections.length` rides along on a data attribute so a test can prove
    // PhotosHome is the layer that applies the Library filter — Section shape
    // and grouping are `timeline-rows.ts`'/`PhotoTimeline`'s own concern and
    // stay out of scope here.
    default: ({ sections }: { sections: readonly unknown[] }) =>
      ReactModule.createElement("div", {
        "data-section-count": sections.length,
        "data-testid": "timeline",
      }),
  } as never;
});

// The summary grains (Years / Months). Stubbed for the same reason the
// timeline above is: this file is about which grain PhotosHome hands the
// sections to, not about how a period card packs. `grain` rides along so a
// test can prove the drawer's choice reaches the grid.
vi.mock(import("./PhotoPeriodGrid"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({
      grain,
      sections,
    }: {
      grain: string;
      sections: readonly unknown[];
    }) =>
      ReactModule.createElement("div", {
        "data-grain": grain,
        "data-section-count": sections.length,
        "data-testid": "period-grid",
      }),
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
  // The LIBRARY destination, named. Photos lands on Collections now (issue
  // #712), and every claim in this file is about the timeline shelf — so the
  // shelf is asked for by name rather than assumed to be what opens.
  return {
    navigation: { navigate },
    route: { params: { destination: "library" } },
  } as unknown as HomeProps;
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

/** Renders directly onto an arbitrary destination — the band mock above only
 *  round-trips `library`/`collections`/`search`/`more` through its own key
 *  names, so a destination pressed through the mock and one asked for by
 *  route param land the same way; this helper is used where a test wants a
 *  destination the mock's own buttons do not need to press through, same as
 *  the "keeps the selection bar scoped" test below already does. */
function renderDestination(destination: string): void {
  act(() => {
    root = createRoot(container!);
    root.render(
      <PhotosHome
        navigation={{ navigate: vi.fn<() => void>() } as never}
        route={{ params: { destination } } as never}
      />
    );
  });
}

describe("PhotosHome behavior", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.timeline.loading = true;
    mocks.timeline.assets = [];
    mocks.timeline.sections = [];
    // The default every other test in this file assumes: a grant that can
    // produce a timeline, so nothing takes the grid over.
    mocks.permission = { status: "granted", canAskAgain: false };
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

  // issue #712 — the anchor lives up here, not in the describe string: the
  // mobile-design gate counts `#712` in CODE (strings included) as a hex
  // literal, and comments are the one place it knows to ignore.
  describe("the Library header chip's anchored menu", () => {
    it("opens the menu from the header, beside Select", () => {
      render();
      expect(
        container!.querySelector('[data-testid="library-menu"]')
      ).toBeNull();
      press("View options");
      expect(
        container!.querySelector('[data-testid="library-menu"]')
      ).toBeTruthy();
    });

    it("carries the filter and tile-size rows, and no Sort row at all", () => {
      render();
      press("View options");
      const menu = container!.querySelector('[data-testid="library-menu"]')!;
      expect(menu.textContent).toContain("All Photos");
      expect(menu.textContent).toContain("Favorites");
      // The rung labels, one row each — `photos-rungs.ts`'s own table.
      for (const rung of ["XS", "S", "M", "L"])
        expect(menu.textContent).toContain(rung);
      // Capture date and added date collapse to one key on this vault, so a
      // sort choice would be a lie — see `photos-library-menu.ts`'s header.
      expect(menu.textContent).not.toContain("Sort");
      expect(menu.textContent).not.toContain("Recently Added");
      expect(menu.textContent).not.toContain("Date Captured");
      // Nor a filter row promising a shelf this vault cannot honestly fill —
      // same header comment, on why Videos/Screenshots/Selfies stay out.
      for (const invented of ["Screenshots", "Selfies", "Videos"])
        expect(menu.textContent).not.toContain(invented);
    });

    it("applies the Favorites filter to the sections the grid actually renders", () => {
      // Two sections, one with a favorite and one without — a filter that
      // did nothing, or filtered the wrong axis, would leave both standing.
      mocks.timeline.loading = false;
      mocks.timeline.sections = [
        { day: "2026-07-30", assets: [{ id: "a1", favorite: true }] },
        { day: "2026-07-29", assets: [{ id: "a2", favorite: false }] },
      ];
      render();
      expect(
        container!.querySelector<HTMLElement>('[data-testid="timeline"]')
          ?.dataset.sectionCount
      ).toBe("2");
      press("View options");
      press("Favorites");
      expect(
        container!.querySelector<HTMLElement>('[data-testid="timeline"]')
          ?.dataset.sectionCount
      ).toBe("1");
    });

    it("steps the shared rung from the tile-size rows", () => {
      render();
      press("View options");
      const mark = (label: string): string | null =>
        container!
          .querySelector(`button[aria-label="${label}"]`)!
          .getAttribute("aria-selected");
      // The store's own default (M) is the row that carries the mark.
      expect(mark("M")).toBe("true");
      press("L");
      expect(mark("L")).toBe("true");
      expect(mark("M")).toBe("false");
      // And the menu is still up — a rung row is not a destination.
      expect(
        container!.querySelector('[data-testid="library-menu"]')
      ).toBeTruthy();
    });
  });

  // issue #712 — the anchor lives up here for the same hex-literal reason as
  // the Library describe above.
  describe("the header's trailing control is destination-scoped", () => {
    it("Library shows Sliders (View options) and Select; Collections shows neither", () => {
      renderDestination("library");
      expect(
        container!.querySelector('button[aria-label="View options"]')
      ).toBeTruthy();
      expect(
        container!.querySelector('button[aria-label="Select"]')
      ).toBeTruthy();
      expect(
        container!.querySelector('button[aria-label="Collections options"]')
      ).toBeNull();
    });

    it("Collections shows the ··· chip and Select, but not Sliders", () => {
      renderDestination("collections");
      expect(
        container!.querySelector('button[aria-label="Collections options"]')
      ).toBeTruthy();
      expect(
        container!.querySelector('button[aria-label="View options"]')
      ).toBeNull();
      // Select opens the Library grid's own selection, which is not on
      // screen here — the entry point would be inert, so it does not render.
      expect(
        container!.querySelector('button[aria-label="Select"]')
      ).toBeNull();
    });

    it("Search carries no options chip at all — it has no honest menu of its own", () => {
      renderDestination("search");
      expect(
        container!.querySelector('button[aria-label="View options"]')
      ).toBeNull();
      expect(
        container!.querySelector('button[aria-label="Collections options"]')
      ).toBeNull();
      expect(
        container!.querySelector('button[aria-label="Select"]')
      ).toBeNull();
    });

    it("Collections' chip opens Show All / Collapse All, and Collapse All reaches the view as the lifted state", () => {
      renderDestination("collections");
      press("Collections options");
      const menu = container!.querySelector('[data-testid="library-menu"]')!;
      expect(menu.textContent).toContain("Show All");
      expect(menu.textContent).toContain("Collapse All");
      // Before Collapse All: PhotosHome hands the view an empty fold set.
      expect(
        container!.querySelector<HTMLElement>(
          '[data-testid="collections-view"]'
        )?.dataset.collapsedCount
      ).toBe("0");
      press("Collapse All");
      // After: the SAME lifted state now carries every section key — proof
      // the menu built in PhotosHome and the state PhotosCollectionsView
      // renders from are the one `collapsedSections`, not two copies.
      expect(
        container!.querySelector<HTMLElement>(
          '[data-testid="collections-view"]'
        )?.dataset.collapsedCount
      ).toBe("8");
    });
  });

  describe("permission is a takeover of the grid (§13, issue 712 P13)", () => {
    it("renders the refusal grammar where the grid would have been", () => {
      mocks.timeline.loading = false;
      mocks.permission = { status: "denied", canAskAgain: true };
      render();
      // What was tried, why it was refused, what to do — the three parts §13
      // asks for, all inside the content slot.
      expect(container!.textContent).toContain(
        "Photos cannot reach your camera roll"
      );
      expect(container!.textContent).toContain("Nothing has been lost");
      expect(
        container!.querySelector('button[aria-label="Allow access"]')
      ).toBeTruthy();
    });

    it("keeps the band up and shows no grid behind the refusal", () => {
      mocks.timeline.loading = false;
      mocks.permission = { status: "denied", canAskAgain: true };
      render();
      // The way out of Photos is never what a refusal takes away.
      expect(container!.querySelector('[data-testid="band"]')).toBeTruthy();
      expect(container!.querySelector('[data-testid="timeline"]')).toBeNull();
    });

    it("SABOTAGE: a denied grant never leaves a dead grid behind", () => {
      mocks.timeline.loading = false;
      mocks.permission = { status: "denied", canAskAgain: false };
      render();
      // The empty-library sentence is for a granted-but-empty library. Showing
      // it here is exactly the lie P13 removed: it invites the member to take
      // photographs the app would still not be allowed to read.
      expect(container!.textContent).not.toContain("Your library starts here");
      expect(
        container!.querySelector('[aria-label="Opening your library"]')
      ).toBeNull();
    });

    it("a limited grant that CAN show photographs shows them, not the panel", () => {
      // The member picked a set; hiding it behind the panel would hide the
      // very thing they granted.
      mocks.timeline.loading = false;
      mocks.timeline.assets = [{ id: "a1", source: "device" }];
      mocks.timeline.sections = [{ day: "2026-07-30" }];
      mocks.permission = {
        status: "granted",
        accessPrivileges: "limited",
        canAskAgain: false,
      };
      render();
      expect(container!.querySelector('[data-testid="timeline"]')).toBeTruthy();
      expect(container!.textContent).not.toContain(
        "Photos can reach some of your camera roll"
      );
    });

    it("says nothing while the OS has not answered — unknown is not denied", () => {
      mocks.timeline.loading = false;
      mocks.permission = null;
      render();
      expect(container!.textContent).not.toContain("camera roll");
      // Not a takeover: the library's own slot is still the library's, and
      // nothing is asking for a grant the OS has not been asked for yet.
      expect(
        container!.querySelector('button[aria-label="Allow access"]')
      ).toBeNull();
      expect(container!.textContent).toContain("Your library starts here");
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

  // iOS PHOTOS' OWN SELECT UX (issue #712). Entering select swaps the band's
  // own foot for a bar carrying the count and the selection's two verbs; the
  // header keeps the page title and sheds every action but the one that did
  // not fit (Backup) plus the ✕ that exits.
  describe("selecting swaps the band for the selection bar", () => {
    function renderSelectable(): void {
      mocks.timeline.loading = false;
      mocks.timeline.assets = [{ id: "a1", source: "device" }];
      mocks.timeline.sections = [
        { day: "2026-07-30", assets: [{ id: "a1", favorite: false }] },
      ];
      render();
    }

    it("entering select hides the band and shows the count bar", () => {
      renderSelectable();
      expect(container!.querySelector('[data-testid="band"]')).toBeTruthy();
      press("Select");
      expect(container!.querySelector('[data-testid="band"]')).toBeNull();
      expect(container!.textContent).toContain("1 Photo Selected");
    });

    it("exiting select (✕) restores the band and drops the count bar", () => {
      renderSelectable();
      press("Select");
      expect(container!.textContent).toContain("1 Photo Selected");
      press("Done");
      expect(container!.querySelector('[data-testid="band"]')).toBeTruthy();
      expect(container!.textContent).not.toContain("Photo Selected");
    });

    it("renders exactly the honest action set: Add to album and Trash on the bar, Backup alone in the header", () => {
      renderSelectable();
      press("Select");
      // The bar's two verbs.
      expect(
        container!.querySelector('button[aria-label="Add to album"]')
      ).toBeTruthy();
      expect(
        container!.querySelector('button[aria-label="Move to trash"]')
      ).toBeTruthy();
      // The header's one leftover action, plus the exit.
      expect(
        container!.querySelector('button[aria-label="Back up to the gateway"]')
      ).toBeTruthy();
      expect(
        container!.querySelector('button[aria-label="Done"]')
      ).toBeTruthy();
      // What select mode retires from the header: the count moved to the
      // bar, and the Library-only view-options chip has no place in it.
      expect(
        container!.querySelector('button[aria-label="View options"]')
      ).toBeNull();
      expect(
        container!.querySelector('button[aria-label="Select"]')
      ).toBeNull();
      // The page title survives select — this is still Photos, not a new
      // surface.
      expect(container!.textContent).toContain("Photos");
    });

    it("keeps the selection bar scoped to the Library destination", () => {
      // A selection can only ever be POPULATED by the timeline (§ header
      // comment above `selecting` in PhotosHome.tsx), and — issue #712 — the
      // header's own "Select" entry point is scoped the same way now: it no
      // longer renders on a destination whose grid it cannot select from, so
      // this proves both that the chip is absent on Collections AND that,
      // even if `selection` held a stale value from an earlier Library
      // visit, `selecting`'s own `destination === "library"` guard would
      // still keep the bar down.
      mocks.timeline.loading = false;
      mocks.timeline.assets = [{ id: "a1", source: "device" }];
      mocks.timeline.sections = [];
      act(() => {
        root = createRoot(container!);
        root.render(
          <PhotosHome
            navigation={{ navigate: vi.fn<() => void>() } as never}
            route={{ params: { destination: "collections" } } as never}
          />
        );
      });
      expect(
        container!.querySelector('button[aria-label="Select"]')
      ).toBeNull();
      // No band swap, no count bar: the destination never became "library".
      expect(container!.querySelector('[data-testid="band"]')).toBeTruthy();
      expect(container!.textContent).not.toContain("Photo Selected");
      expect(
        container!.querySelector('button[aria-label="Move to trash"]')
      ).toBeNull();
    });
  });
});
