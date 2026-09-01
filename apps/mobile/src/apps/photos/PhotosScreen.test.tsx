// Every non-lightbox Photos surface renders the band with the Home capsule
// (`popTo`, never `goBack()`). A live selection replaces the band.
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

// The vault lockup every app frame draws. Stubbed because this file's claim is
// PhotosScreen's own composition, not the header's: mounting the real one pulls
// the active-vault read and its native storage into a project that has no setup
// file to seam them (unlike the RNTL tier's `native-device-seams.ts`).
vi.mock(import("../../screens/home/VaultBar"), () => ({
  default: (): React.JSX.Element => React.createElement("view"),
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
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
      family: { sansMedium: "sans-medium", sansRegular: "sans-regular" },
      radii: { lg: 12, md: 8, pill: 999, sm: 4, xl: 16, xs: 0 },
      t: () => ({}),
      useTheme: () => ({
        colors: {
          bg: "#bg",
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
    expect(mocks.popTo).toHaveBeenCalledWith("Home");
    // `navigate` PUSHES a second Home; UIKit then presents it as a card sheet.
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("SABOTAGE: a destination pops to the stack's home, never pushes a second", () => {
    render(<PhotosScreen current="more">{null}</PhotosScreen>);
    press("Library");
    expect(mocks.popTo).toHaveBeenCalledWith("PhotosHome", {
      destination: "library",
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe("the bar sits BESIDE the content, never over it", () => {
  beforeEach(mount);
  afterEach(unmount);

  const shelf = (): React.JSX.Element =>
    React.createElement("main", { "data-testid": "shelf" });

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
    const band = container!.querySelector('[role="tablist"]')!.parentElement!;

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
    // Absolute ancestor takes the band out of flow; slot padding cannot fix it.
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
    const labels = buildSelectionActions(props).map((action) => action.label);
    expect(labels).toHaveLength(5);
    for (const label of labels) expect(control(label)).toBeTruthy();
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
    act(() =>
      favorite!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(props.favorite.run).not.toHaveBeenCalled();
    expect(container!.textContent).toContain(
      "This vault is read-only for you."
    );
  });
});
