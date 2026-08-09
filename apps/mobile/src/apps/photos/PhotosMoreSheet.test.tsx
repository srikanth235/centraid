// Pins the More sheet's anatomy (issue #711, cut back in #712):
//
//  - it carries exactly what `PHOTOS_MORE_ROWS` names, which is now ONE row.
//    The five shelves it used to list — Sharing, Favorites, Places,
//    Duplicates, Trash — are sections of Collections, on screen with their
//    own counts, so a row here would be a second hidden door to each. A stray
//    reintroduction is caught here and in `photos-more-router.test.ts`
//  - Backup carries no meta: the figure would come from a network round trip
//    this sheet has no business making, and a placeholder is the lie the old
//    meta map existed to avoid
//  - tapping a row calls `onSelect` with that row's OWN key, never a
//    different one — the same "labelled destination opens something else"
//    defect class this issue is about, one level up from the router itself
//  - the foot line is the exact spec copy, and the old invented "More"
//    eyebrow is gone
//
// Tile size is NOT covered here any more — it moved on from this sheet to
// the Library's own header menu (`photos-library-menu.test.ts` carries the
// rung rows now); see `PhotosMoreSheet.tsx`'s header for why.
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

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    bgElev: "#mock-bg-elev",
    line: "#mock-line",
    scrim: "#mock-scrim",
    text: "#mock-text",
    textDisabled: "#mock-text-disabled",
    textFaint: "#mock-text-faint",
    textSoft: "#mock-text-soft",
  },
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

  it("carries exactly one row — Backup — and no shelf Collections shows", () => {
    renderSheet();
    const labels = Array.from(container!.querySelectorAll("button"))
      .map((button) => button.getAttribute("aria-label") ?? "")
      // Close is a CONTROL, not a destination — this count is of
      // destinations, which is what the cap is about.
      .filter((label) => label !== "Close");
    // One row. Backup is not a shelf — it is a policy screen in the frame,
    // about whether this device's bytes have left it, and that policy governs
    // Docs' scans and Notes' attachments too.
    expect(labels).toStrictEqual(["Backup"]);
    for (const shelf of [
      "Sharing",
      "Favorites",
      "Places",
      "Duplicates",
      "Trash",
    ])
      expect(container!.textContent).not.toContain(shelf);
    expect(container!.textContent).not.toContain("Import");
    expect(container!.textContent).not.toContain("Photo access");
  });

  it("omits Backup's meta rather than inventing a number", () => {
    // The row is labelled "Backup" now (#712 B1) and its meta is still absent:
    // the figure it would carry comes from a network round trip this sheet has
    // no business making, and a placeholder number is the lie the whole meta
    // map exists to avoid.
    renderSheet();
    expect(rowButton("Backup").getAttribute("aria-label")).toBe("Backup");
  });

  it("calls onSelect with the OWN key of the row tapped, for every row", () => {
    renderSheet();
    const cases: Array<[string, PhotosMoreRowKey]> = [["Backup", "backup"]];
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

  it("carries no tile-size control — those rows live in the Library header menu now", () => {
    renderSheet();
    expect(container!.textContent).not.toContain("Tile size");
    expect(
      container!.querySelector('button[aria-label="Larger tiles"]')
    ).toBeNull();
    expect(
      container!.querySelector('button[aria-label="Smaller tiles"]')
    ).toBeNull();
  });
});
