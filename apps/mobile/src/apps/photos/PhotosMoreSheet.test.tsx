// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      .filter((label) => label !== "Close");
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
    expect(closeButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the exact spec foot copy, and no invented eyebrow", () => {
    renderSheet();
    expect(container!.textContent).toContain("Everything Photos can show.");
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
