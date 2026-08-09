// The rule §F argues for, held by a test: EVERY non-lightbox Photos surface
// renders the band, and the band always carries the frame's Home capsule.
//
// Before this shell existed the band was rendered by exactly one screen, so
// the Library index, one album, Backup, Duplicates and Trash were dead ends —
// the OS back gesture was the only way out. The two assertions here are the
// ones that would have caught that:
//
//   (a) a screen wrapped in the shell renders the band, with a Home capsule
//       whose one tap goes Home (never `goBack()`, which is a no-op when
//       Photos was opened by deep link);
//   (b) while a selection is live the band is REPLACED by the selection bar,
//       and a disabled write target's handler does not fire.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSelectionActions } from "@centraid/blueprints/apps/_shared/selection-engine";

// @vitest-environment jsdom
import PhotosScreen from "./PhotosScreen";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  navigate: vi.fn<(...args: unknown[]) => void>(),
  popTo: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  // The one style property the layout test is about, surfaced onto the DOM so
  // an absolute band slot cannot come back unnoticed. Styles arrive as an
  // object, an array, or a nested array, so this flattens all three.
  const positionOf = (style: unknown): string | undefined => {
    if (Array.isArray(style)) {
      for (const entry of style) {
        const found = positionOf(entry);
        if (found) return found;
      }
      return undefined;
    }
    const position = (style as { position?: string } | null)?.position;
    return typeof position === "string" ? position : undefined;
  };
  return {
    Pressable: ({
      accessibilityLabel,
      children,
      disabled,
      onPress,
    }: {
      accessibilityLabel?: string;
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      ReactModule.createElement(
        "button",
        {
          "aria-label": accessibilityLabel,
          // The real `Pressable` refuses the press itself; jsdom's <button>
          // does the same with `disabled`, so the mock keeps the property the
          // sabotage assertion below is about.
          disabled,
          onClick: onPress,
          type: "button",
        },
        children
      ),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    Text: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("span", {}, children),
    View: ({
      accessibilityRole,
      children,
      style,
    }: {
      accessibilityRole?: string;
      children?: React.ReactNode;
      style?: unknown;
    }) =>
      ReactModule.createElement(
        "div",
        { "data-position": positionOf(style), role: accessibilityRole },
        children
      ),
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
  import("@react-navigation/native"),
  () =>
    ({
      useNavigation: () => ({ navigate: mocks.navigate, popTo: mocks.popTo }),
    }) as never
);

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
  import("../../kit/theme"),
  () =>
    ({
      borders: { hairline: 1 },
      // The band's label carries state in its WEIGHT (:4975), so it names two
      // families rather than taking the `control` role wholesale.
      family: { sansMedium: "sans-medium", sansRegular: "sans-regular" },
      t: () => ({}),
      useTheme: () => ({
        colors: {
          bg: "#bg",
          // The claimed band's two plates: the capsule on the frame's neutral
          // page (`bg`), the tab group on `bgElev`, both edged `lineStrong`.
          bgElev: "#elev",
          line: "#line",
          lineStrong: "#lineStrong",
          net: "#net",
          text: "#text",
          textDisabled: "#disabled",
          textFaint: "#faint",
          textSoft: "#soft",
        },
      }),
    }) as never
);

vi.mock(
  import("../../storage"),
  () =>
    ({
      Store: { hydrate: async () => "app" },
    }) as never
);

vi.mock(import("./PhotosMoreSheet"), () => ({ default: () => null }) as never);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(node: React.JSX.Element): void {
  act(() => {
    root = createRoot(container!);
    root.render(node);
  });
}

function control(label: string): HTMLButtonElement | null {
  return container!.querySelector(`button[aria-label="${label}"]`);
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  mocks.navigate.mockClear();
  mocks.popTo.mockClear();
}

function unmount(): void {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

function press(label: string): void {
  const button = control(label);
  expect(button).toBeTruthy();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("the band is on every Photos surface", () => {
  beforeEach(mount);
  afterEach(unmount);

  it("renders the four destinations and the frame's Home capsule", () => {
    render(<PhotosScreen current="more">{null}</PhotosScreen>);
    for (const label of ["Library", "Collections", "Search", "More"])
      expect(control(label)).toBeTruthy();
    expect(control("Home")).toBeTruthy();
  });

  it("SABOTAGE: the capsule POPS home, never back and never navigate", () => {
    render(<PhotosScreen current="collections">{null}</PhotosScreen>);
    press("Home");
    // `goBack()` is a no-op when Photos was entered by deep link, which left
    // the one frame control on the surface doing nothing at all.
    expect(mocks.popTo).toHaveBeenCalledWith("Home");
    // And `navigate` is the OTHER wrong answer: on React Navigation 7 it
    // PUSHES a second Home above the Photos cover instead of returning to the
    // one beneath, and UIKit presents a screen above a `fullScreenModal` as an
    // inset card sheet — so Home arrived looking like a drawer.
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("SABOTAGE: a destination pops to the stack's home, never pushes a second", () => {
    render(<PhotosScreen current="more">{null}</PhotosScreen>);
    press("Library");
    expect(mocks.popTo).toHaveBeenCalledWith("PhotosHome", {
      destination: "library",
    });
    // Same defect, one level down: `navigate` would stack a second
    // `PhotosHome` on top of the album the member was in.
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe("the bar sits BESIDE the content, never over it", () => {
  beforeEach(mount);
  afterEach(unmount);

  /** A stand-in for whatever scroll surface a screen puts in the slot. */
  const shelf = (): React.JSX.Element =>
    React.createElement("main", { "data-testid": "shelf" });

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

  it("renders the band as a flex sibling BELOW the content slot", () => {
    render(<PhotosScreen current="library">{shelf()}</PhotosScreen>);
    const frame = container!.firstElementChild!;
    const slot = container!.querySelector(
      '[data-testid="shelf"]'
    )!.parentElement!;
    // The band's row is the parent of its tab group.
    const band = container!.querySelector('[role="tablist"]')!.parentElement!;

    // Siblings under the frame's column, in that order — the band FOLLOWS the
    // content slot instead of floating on top of it.
    expect(slot.parentElement).toBe(frame);
    expect(band.parentElement).toBe(frame);
    expect(slot.nextElementSibling).toBe(band);
  });

  it("SABOTAGE: no absolutely positioned band slot survives", () => {
    render(<PhotosScreen current="library">{shelf()}</PhotosScreen>);
    const band = container!.querySelector('[role="tablist"]')!.parentElement!;
    const slot = container!.querySelector(
      '[data-testid="shelf"]'
    )!.parentElement!;
    // An absolute ancestor anywhere between the band and the frame is the bug:
    // it takes the band out of flow, the slot grows back to full height, and
    // content scrolls underneath again. Padding the slot cannot fix that —
    // it only clears the END of the content, not the middle of a scroll.
    expect(positionsUpFrom(band)).not.toContain("absolute");
    expect(positionsUpFrom(slot)).not.toContain("absolute");
  });
});

describe("a live selection replaces the band", () => {
  beforeEach(mount);
  afterEach(unmount);

  const selection = (readOnlyReason: string | null) => ({
    count: 2,
    shelf: "normal" as const,
    copyLabel: "Copy to Family",
    readOnlyReason,
    favorite: { run: vi.fn<() => void>() },
    addToAlbum: { run: vi.fn<() => void>() },
    share: { run: vi.fn<() => void>() },
    download: { run: vi.fn<() => void>() },
    trash: { run: vi.fn<() => void>() },
  });

  it("swaps the band for five named targets", () => {
    const props = selection(null);
    render(
      <PhotosScreen current="library" selection={props}>
        {null}
      </PhotosScreen>
    );
    // The five labels are the engine's own (`buildSelectionActions`) — read
    // from the same table `SelectionBottomBar` renders, so a label renamed
    // there (e.g. the share target's, issue #726) cannot strand this test.
    const labels = buildSelectionActions(props).map((action) => action.label);
    expect(labels).toHaveLength(5);
    for (const label of labels) expect(control(label)).toBeTruthy();
    // Exactly one bar at the foot: the band is gone while selecting.
    expect(control("Home")).toBeNull();
    expect(control("Library")).toBeNull();
  });

  it("SABOTAGE: a disabled write target's handler does not fire", () => {
    const props = selection("This vault is read-only for you.");
    render(
      <PhotosScreen current="library" selection={props}>
        {null}
      </PhotosScreen>
    );
    const favorite = control("Favorite");
    expect(favorite?.disabled).toBe(true);
    // Dispatched straight at the element — past the pointer, past the
    // `disabled` attribute a synthetic activation can ignore.
    act(() =>
      favorite!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(props.favorite.run).not.toHaveBeenCalled();
    // …and the reason is on the surface, not only in a hint.
    expect(container!.textContent).toContain(
      "This vault is read-only for you."
    );
  });
});
