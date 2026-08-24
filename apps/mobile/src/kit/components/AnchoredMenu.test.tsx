// Pins the anchored menu's anatomy (#712):
//
//  - every group's rows render, and a group boundary is a rule rather than a
//    heading
//  - the active row — and only it — carries the leading mark, and says so in
//    its own accessibility label
//  - a disclosure row swaps the card to its submenu IN PLACE, with a named way
//    back; the parent's rows return exactly as they were
//  - a plain row closes the card, a `staysOpen` row does not (iOS' zoom rows)
//  - the backdrop dismisses
//  - destructive and disabled rows take their own ink on the LEAF, never a
//    container opacity (§18)
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import AnchoredMenu from "./AnchoredMenu";
import type { MenuGroup } from "./AnchoredMenu";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../theme");
type IconModule = typeof import("./Icon");
type NativeTextModule = typeof import("./NativeText");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  colors: {
    bgElev: "#mock-bg-elev",
    danger: "#mock-danger",
    line: "#mock-line",
    lineStrong: "#mock-line-strong",
    text: "#mock-text",
    textDisabled: "#mock-text-disabled",
    textFaint: "#mock-text-faint",
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
      accessibilityState,
      children,
      disabled,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean; disabled?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      element("button", {
        "aria-disabled": accessibilityState?.disabled ? "true" : "false",
        "aria-label": accessibilityLabel,
        "aria-selected": accessibilityState?.selected ? "true" : "false",
        children,
        disabled,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      }),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
    StyleSheet: {
      absoluteFill: {},
      create: <T,>(styles: T): T => styles,
    },
    // The ONE style fact these tests read: whichever `color` a row's label
    // resolved to, surfaced onto the DOM so the destructive and disabled inks
    // can be asserted without a native renderer.
    Text: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) => element("span", { children, "data-color": inkOf(style) }),
    useWindowDimensions: () => ({ height: 800, width: 390 }),
    View: ({
      accessibilityRole,
      children,
    }: {
      accessibilityRole?: string;
      children?: React.ReactNode;
    }) => element("div", { children, role: accessibilityRole }),
  } as unknown as Partial<ReactNative>;
});

/** Flattens the array-of-styles a label carries down to whichever `color`
 *  wins — the same shape RN itself resolves. */
function inkOf(style: unknown): string | undefined {
  if (Array.isArray(style)) {
    let found: string | undefined;
    for (const entry of style) found = inkOf(entry) ?? found;
    return found;
  }
  const value = (style as { color?: string } | null | undefined)?.color;
  return typeof value === "string" ? value : undefined;
}

vi.mock(
  import("../theme"),
  () =>
    ({
      borders: { hairline: 1 },
      spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 },
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors }),
    }) as unknown as Partial<ThemeModule>
);

// The glyph's NAME is what a test can hold — the checkmark is the mark, and a
// row that swapped it for another icon would be a different statement.
vi.mock(import("./Icon"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({ name }: { name: string }) =>
      ReactModule.createElement("i", { "data-icon": name }),
  } as unknown as Partial<IconModule>;
});

vi.mock(import("./NativeText"), async () => {
  const ReactModule = await import("react");
  return {
    Text: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) =>
      ReactModule.createElement(
        "span",
        { "data-color": inkOf(style) },
        children
      ),
    TextInput: () => null,
  } as unknown as Partial<NativeTextModule>;
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let chose: string[];

/** The Library's own shape, near enough to be worth testing against: an
 *  exclusive filter submenu, a stepping submenu that stays open, and a
 *  destructive/disabled pair in a group of their own. */
function groups(): MenuGroup[] {
  return [
    {
      key: "views",
      rows: [
        {
          key: "filter",
          label: "Filter",
          rows: [
            {
              key: "all",
              label: "All Photos",
              checked: true,
              onSelect: () => chose.push("all"),
            },
            {
              key: "favorites",
              label: "Favorites",
              onSelect: () => chose.push("favorites"),
            },
          ],
        },
        {
          key: "size",
          label: "View Options",
          rows: [
            {
              key: "s",
              label: "Small",
              staysOpen: true,
              onSelect: () => chose.push("s"),
            },
            {
              key: "m",
              label: "Medium",
              checked: true,
              staysOpen: true,
              onSelect: () => chose.push("m"),
            },
          ],
        },
      ],
    },
    {
      key: "acts",
      rows: [
        {
          key: "trash",
          label: "Move to Trash",
          destructive: true,
          onSelect: () => chose.push("trash"),
        },
        {
          key: "share",
          label: "Share",
          disabled: true,
          onSelect: () => chose.push("share"),
        },
      ],
    },
  ];
}

function render(anchor?: {
  x: number;
  y: number;
  width: number;
  height: number;
}): void {
  onClose = vi.fn<() => void>();
  chose = [];
  act(() => {
    root = createRoot(container!);
    root.render(
      <AnchoredMenu
        visible
        anchor={anchor}
        groups={groups()}
        onClose={onClose}
      />
    );
  });
}

function row(label: string): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label")?.startsWith(label)
  );
  if (!button) throw new Error(`No row starting with "${label}"`);
  return button;
}

function press(label: string): void {
  act(() => row(label).click());
}

function labels(): string[] {
  return Array.from(container!.querySelectorAll("button")).map(
    (button) => button.getAttribute("aria-label") ?? ""
  );
}

// #712 — anchored in a comment, never in a describe string: the
// mobile-design gate counts `#712` in code (strings included) as a hex literal.
describe("the anchored menu's rows", () => {
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

  it("renders every group's rows, in order", () => {
    render();
    expect(labels()).toStrictEqual([
      "Close menu",
      "Filter. Opens a submenu",
      "View Options. Opens a submenu",
      "Move to Trash",
      "Share",
    ]);
  });

  it("renders nothing at all while closed", () => {
    act(() => {
      root = createRoot(container!);
      root.render(
        <AnchoredMenu
          visible={false}
          anchor={undefined}
          groups={groups()}
          onClose={vi.fn<() => void>()}
        />
      );
    });
    expect(container!.textContent).toBe("");
  });

  it("marks exactly the checked row, and says so in its own label", () => {
    render();
    press("Filter");
    expect(row("All Photos").getAttribute("aria-selected")).toBe("true");
    expect(row("Favorites").getAttribute("aria-selected")).toBe("false");
    // The mark itself, not merely the state: a checkmark glyph in the leading
    // slot of the checked row and of no other.
    const marks = container!.querySelectorAll('i[data-icon="check"]');
    expect(marks).toHaveLength(1);
    expect(row("All Photos").contains(marks[0]!)).toBe(true);
    expect(row("All Photos").getAttribute("aria-label")).toBe(
      "All Photos. Selected"
    );
  });

  it("dismisses from the backdrop", () => {
    render();
    press("Close menu");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("one level of nesting, opened in place", () => {
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

  it("swaps the card to the submenu, with a named way back", () => {
    render();
    press("Filter");
    expect(labels()).toStrictEqual([
      "Close menu",
      "Back to Filter",
      "All Photos. Selected",
      "Favorites",
    ]);
    // The parent's OTHER rows are gone while the submenu is up — this is one
    // card showing one level, not two lists stacked.
    expect(container!.textContent).not.toContain("Move to Trash");
  });

  it("returns to the parent's rows, exactly as they were", () => {
    render();
    press("Filter");
    press("Back to Filter");
    expect(labels()).toStrictEqual([
      "Close menu",
      "Filter. Opens a submenu",
      "View Options. Opens a submenu",
      "Move to Trash",
      "Share",
    ]);
  });

  it("closes on a plain choice and reports the row's own value", () => {
    render();
    press("Filter");
    press("Favorites");
    expect(chose).toStrictEqual(["favorites"]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the card up for a staysOpen row — iOS' zoom rows", () => {
    render();
    press("View Options");
    press("Small");
    expect(chose).toStrictEqual(["s"]);
    expect(onClose).not.toHaveBeenCalled();
    // Still in the submenu, so a second rung is one tap away rather than
    // three.
    expect(row("Small")).toBeTruthy();
  });
});

describe("the inks a row's own state takes", () => {
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

  it("gives a destructive row the danger ink on the leaf", () => {
    render();
    expect(row("Move to Trash").querySelector("span")?.dataset.color).toBe(
      mocks.colors.danger
    );
  });

  it("gives a disabled row the disabled ink and refuses the press", () => {
    render();
    const share = row("Share");
    expect(share.querySelector("span")?.dataset.color).toBe(
      mocks.colors.textDisabled
    );
    expect(share.getAttribute("aria-disabled")).toBe("true");
    expect(share.disabled).toBe(true);
    press("Share");
    expect(chose).toStrictEqual([]);
  });

  it("leaves an ordinary row the plain text ink", () => {
    render();
    expect(row("Filter").querySelector("span")?.dataset.color).toBe(
      mocks.colors.text
    );
  });
});
