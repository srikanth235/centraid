import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      popoverShadow: {
        elevation: 8,
        shadowColor: "#141414",
        shadowOffset: { height: 8, width: 0 },
        shadowOpacity: 0.1,
        shadowRadius: 10,
      },
      spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 },
      t: () => ({}),
      useTheme: () => ({ colors: mocks.colors }),
    }) as unknown as Partial<ThemeModule>
);

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

  it("gives a disabled row the disabled ink and withholds its choice", () => {
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
// @vitest-environment jsdom
