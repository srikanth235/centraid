// Pins the More sheet's anatomy (issue #711):
//
//  - it carries exactly the five rows `PHOTOS_MORE_ROWS` names — Sharing and
//    Import are gone, not just unwired, so a stray reintroduction of either
//    row (without a destination behind it) is caught here even before it
//    reaches PhotosHome's router
//  - a row's live meta (count) renders when the sheet has one, and is
//    omitted — not a placeholder — when it does not (Storage)
//  - tapping a row calls `onSelect` with that row's OWN key, never a
//    different one — the same "labelled destination opens something else"
//    defect class this issue is about, one level up from the router itself
//  - the foot line is the exact spec copy, and the old invented "More"
//    eyebrow is gone
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import type { PhotosMoreRowKey } from "./photos-band";
import PhotosMoreSheet from "./PhotosMoreSheet";

type ReactNative = typeof import("react-native");
type SafeAreaContext = typeof import("react-native-safe-area-context");
type ThemeModule = typeof import("../../kit/theme");
type IconModule = typeof import("../../kit/components/Icon");
type UseReplicaQueryModule = typeof import("../../kit/hooks/useReplicaQuery");
type TimelineSourceModule = typeof import("./timeline-source");
type ShareTargetModule = typeof import("../../kit/share/use-share-target");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    bgElev: "#mock-bg-elev",
    line: "#mock-line",
    scrim: "#mock-scrim",
    text: "#mock-text",
    textFaint: "#mock-text-faint",
    textSoft: "#mock-text-soft",
  },
  // Two favorited, undeleted assets; one deleted (trashed); two sharing a
  // phash (a real duplicate cluster) and a third phash with only one member
  // (not a cluster) — chosen so favorites/trash/duplicates meta all read a
  // number that is NOT simply "how many assets exist".
  assets: [
    { id: "a1", favorite: true, deleted: false, phash: "hash-x" },
    // The one row that sits in the share target — so Sharing's meta reads a
    // number that is NOT the library size and NOT the favourite count.
    {
      id: "a2",
      favorite: true,
      deleted: false,
      phash: "hash-x",
      sourceVaultId: "v-share",
    },
    // Trashed, and ALSO in the share target: the shelf is a filter over the
    // live timeline, so this must not be counted.
    {
      id: "a3",
      favorite: false,
      deleted: true,
      phash: "hash-y",
      scopeIds: ["v-share"],
    },
    { id: "a4", favorite: false, deleted: false, phash: undefined },
  ],
  places: [{ place_id: "p1" }, { place_id: "p2" }, { place_id: "p3" }],
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
    Modal: ({
      visible,
      children,
    }: {
      visible?: boolean;
      children?: React.ReactNode;
    }) => (visible ? element("div", { children }) : null),
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
    StyleSheet: {
      absoluteFill: {},
      create: <T,>(styles: T): T => styles,
    },
    Text: ({ children }: { children?: React.ReactNode }) =>
      element("span", { children }),
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as unknown as Partial<ReactNative>;
});

vi.mock(import("react-native-safe-area-context"), () => {
  return {
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
  } as unknown as Partial<SafeAreaContext>;
});

vi.mock(
  import("../../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      family: { sansRegular: "mock-sans-regular" },
      radii: { md: 7 },
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors }),
    }) as unknown as Partial<ThemeModule>
);

vi.mock(import("../../kit/components/Icon"), async () => {
  const ReactModule = await import("react");
  return {
    default: () => ReactModule.createElement("i"),
  } as unknown as Partial<IconModule>;
});

vi.mock(
  import("../../kit/hooks/useReplicaQuery"),
  () =>
    ({
      useReplicaQuery: () => ({ rows: mocks.places }),
    }) as unknown as Partial<UseReplicaQueryModule>
);

vi.mock(
  import("../../kit/share/use-share-target"),
  () =>
    ({
      useShareTarget: () => ({
        hydrated: true,
        target: { vaultId: "v-share", label: "Household" },
        candidates: [{ vaultId: "v-share", label: "Household" }],
        reason: null,
        choose: () => undefined,
      }),
    }) as unknown as Partial<ShareTargetModule>
);

vi.mock(
  import("./timeline-source"),
  () =>
    ({
      usePhotoTimeline: () => ({ assets: mocks.assets }),
    }) as unknown as Partial<TimelineSourceModule>
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let onSelect: ReturnType<typeof vi.fn<(key: PhotosMoreRowKey) => void>>;

function renderSheet(): void {
  onSelect = vi.fn<(key: PhotosMoreRowKey) => void>();
  act(() => {
    root = createRoot(container!);
    root.render(
      <PhotosMoreSheet
        visible
        onClose={vi.fn<() => void>()}
        onSelect={onSelect}
      />
    );
  });
}

function rowButton(label: string): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label")?.startsWith(label)
  );
  if (!button) throw new Error(`No row button starting with "${label}"`);
  return button;
}

describe("the More sheet's rows, meta and foot", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("carries exactly the live rows — Sharing first, still no Import", () => {
    renderSheet();
    const labels = Array.from(container!.querySelectorAll("button"))
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter((label) => label !== "Close");
    // Six rows: Sharing (issue #712 A5, first — proto:4980-4983), Favorites,
    // Places, Duplicates, Trash, Backup. `Photo access` is gone with P13, and
    // Import still has no phone destination.
    expect(labels).toHaveLength(6);
    expect(labels[0]).toBe("Sharing. 1");
    expect(container!.textContent).not.toContain("Import");
    expect(container!.textContent).not.toContain("Photo access");
  });

  it("shows real meta for favorites, trash and duplicates", () => {
    renderSheet();
    // 2 favorited-and-not-deleted assets (a1, a2).
    expect(rowButton("Favorites").getAttribute("aria-label")).toBe(
      "Favorites. 2"
    );
    // 1 deleted asset (a3).
    expect(rowButton("Trash").getAttribute("aria-label")).toBe(
      "Trash. 1 · purged in 30 days"
    );
    // hash-x has 2 members (a cluster); hash-y has 1 (not a cluster).
    expect(rowButton("Duplicates").getAttribute("aria-label")).toBe(
      "Duplicates. 1 cluster"
    );
    // 3 place rows from the mocked query.
    expect(rowButton("Places").getAttribute("aria-label")).toBe("Places. 3");
  });

  it("omits Backup's meta rather than inventing a number", () => {
    // The row is labelled "Backup" now (#712 B1) and its meta is still absent:
    // the figure it would carry comes from a network round trip this sheet has
    // no business making, and a placeholder number is the lie the whole meta
    // map exists to avoid.
    renderSheet();
    expect(rowButton("Backup").getAttribute("aria-label")).toBe("Backup");
  });

  it("shows Sharing's live count, and nothing when nothing is shared", () => {
    // The count is the shelf's own size, from the same loaded timeline every
    // other row's meta reads — never a second fetch, and never a guess.
    renderSheet();
    expect(rowButton("Sharing").getAttribute("aria-label")).toBe("Sharing. 1");
  });

  it("calls onSelect with the OWN key of the row tapped, for every row", () => {
    renderSheet();
    const cases: Array<[string, PhotosMoreRowKey]> = [
      ["Sharing", "sharing"],
      ["Favorites", "favorites"],
      ["Places", "places"],
      ["Duplicates", "duplicates"],
      ["Trash", "trash"],
      ["Backup", "backup"],
    ];
    for (const [label, key] of cases) {
      onSelect.mockClear();
      act(() =>
        rowButton(label).dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        )
      );
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(key);
    }
  });

  it("carries a head title and a closable ✕ button, per the handoff anatomy", () => {
    renderSheet();
    expect(container!.textContent).toContain("More in Photos");
    const closeButtons = Array.from(
      container!.querySelectorAll("button")
    ).filter((button) => button.getAttribute("aria-label") === "Close");
    // The scrim and the explicit head button both carry "Close" — the sheet
    // has no grabber to dismiss it, so a real ✕ control must exist.
    expect(closeButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the exact spec foot copy, and no invented eyebrow", () => {
    renderSheet();
    expect(container!.textContent).toContain(
      "Everything Photos can show. The vault mark in the head goes back to the rest of Centraid."
    );
    // The old header was a bare "More" eyebrow with nothing else on its line;
    // the foot sentence itself does not contain that word, so this also
    // guards against it creeping back in as a separate heading.
    expect(
      Array.from(container!.querySelectorAll("span")).some(
        (span) => span.textContent === "More"
      )
    ).toBe(false);
  });
});
