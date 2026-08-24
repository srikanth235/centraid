// Regression coverage for the v4 Binding Layer search overlay anatomy
// (#711). This isn't a snapshot of every pixel — it pins the handful of rules
// a future edit is likeliest to silently undo, every one of which has been
// reintroduced at least once:
//
//  - the panel is OPAQUE paper (bg-elev), never glass — no translucent tint
//    film anywhere in the tree
//  - the try-chips are an empty-query-only affordance
//  - the foot is the exact two-part copy the brief specifies
//  - the empty line is the exact spec string, smart quotes included
//  - there is no app-filter row, no APPS icon grid, no RECENTS section
//
// The absence checks are structural: they inspect the
// *rendered* tree (via mocked primitives that leave a fingerprint if used),
// not the source text, so they still catch a reintroduction that renames
// variables or restyles things.

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import SearchOverlay from "./SearchOverlay";
import type { SearchOverlayProps } from "./SearchOverlay";

type ReactNative = typeof import("react-native");
type SafeAreaContext = typeof import("react-native-safe-area-context");
type ThemeModule = typeof import("../../kit/theme");
type ReplicaProviderModule = typeof import("../../kit/replica/ReplicaProvider");
type UseSearchRecentsModule = typeof import("./useSearchRecents");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Solid, alpha-free values on every rung — a translucent film sneaking back
// in would show up as an `rgba(` value on some `data-bg`, which the opaque-
// panel test below scans for directly.
const mocks = vi.hoisted(() => ({
  colors: {
    accent: "#mock-accent",
    bgElev: "#mock-bg-elev",
    line: "#mock-line",
    lineStrong: "#mock-line-strong",
    text: "#mock-text",
    textFaint: "#mock-text-faint",
    textInv: "#mock-text-inv",
    textSoft: "#mock-text-soft",
  },
  suggestions: ["Pemberton", "right of way", "Ana"],
}));

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style))
    return style.reduce(
      (acc: Record<string, unknown>, s) => Object.assign(acc, flattenStyle(s)),
      {}
    );
  if (typeof style === "object") return style as Record<string, unknown>;
  return {};
}

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
    Platform: { OS: "ios" },
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      children,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean };
      children?: React.ReactNode;
      onPress?: () => void;
    }) =>
      element("button", {
        "aria-label": accessibilityLabel,
        "aria-selected": accessibilityState?.selected,
        children,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      }),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("main", { children }),
    StyleSheet: {
      absoluteFill: {
        bottom: 0,
        left: 0,
        position: "absolute",
        right: 0,
        top: 0,
      },
      create: <T,>(styles: T): T => styles,
    },
    // Layout fingerprints for the foot assertions: the note's `flex` and
    // `textAlign` become data attributes, so the no-overflow contract (the
    // hint is bounded to its own trailing column) is testable on the
    // rendered tree.
    Text: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) => {
      const flat = flattenStyle(style);
      return element("span", {
        ...(flat.flex === undefined ? {} : { "data-flex": String(flat.flex) }),
        ...(typeof flat.textAlign === "string"
          ? { "data-textalign": flat.textAlign }
          : {}),
        children,
      });
    },
    TextInput: ({
      accessibilityLabel,
      onChangeText,
      placeholder,
      value,
      ...rest
    }: {
      accessibilityLabel?: string;
      onChangeText?: (value: string) => void;
      placeholder?: string;
      value?: string;
      [key: string]: unknown;
    }) =>
      element("input", {
        "aria-label": accessibilityLabel,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          onChangeText?.(event.target.value),
        placeholder,
        value,
        ...Object.fromEntries(
          Object.entries(rest).filter(
            ([key]) => !["style", "placeholderTextColor"].includes(key)
          )
        ),
      }),
    // The one View mock detail this suite leans on: a `backgroundColor` in
    // the (possibly array) style becomes a `data-bg` attribute, so the
    // opaque-panel test can find and inspect every background actually
    // painted, instead of trusting that nothing else was added.
    View: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) => {
      const flat = flattenStyle(style);
      const bg = flat.backgroundColor;
      return element("div", {
        ...(typeof bg === "string" ? { "data-bg": bg } : {}),
        // A `flexWrap` fingerprint, so the one-row try-chip contract can
        // assert that no wrapping row ever comes back.
        ...(typeof flat.flexWrap === "string"
          ? { "data-flexwrap": flat.flexWrap }
          : {}),
        children,
      });
    },
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
      // The shared page margin the overlay insets its content by — the same
      // 18 the generated lowering carries (handoff `R.margin.m`, :3356).
      pageMargin: 18,
      t: () => ({}),
      useTheme: () => ({
        colors: mocks.colors,
        radii: { lg: 12, md: 7, pill: 999, sm: 4, xl: 12, xs: 0 },
        scheme: "light",
        targetMin: { coarse: 48, fine: 32 },
      }),
    }) as unknown as Partial<ThemeModule>
);

// No paired gateway in this suite — the search effect no-ops without a
// session, which is exactly the state the empty-copy and foot-format
// assertions below want (predictable, always-zero results).
vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({ session: undefined }),
    }) as unknown as Partial<ReplicaProviderModule>
);

vi.mock(
  import("./useSearchRecents"),
  () =>
    ({
      useSearchRecents: () => ({ recents: [], suggestions: mocks.suggestions }),
    }) as unknown as Partial<UseSearchRecentsModule>
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let onClose: ReturnType<typeof vi.fn<() => void>>;

function renderOverlay(overrides: Partial<SearchOverlayProps> = {}): void {
  onClose = vi.fn<() => void>();
  const props: SearchOverlayProps = {
    items: [],
    onClose,
    onOpen: vi.fn<SearchOverlayProps["onOpen"]>(),
    ...overrides,
  };
  act(() => {
    root = createRoot(container!);
    root.render(<SearchOverlay {...props} />);
  });
}

function input(): HTMLInputElement {
  return container!.querySelector("input")!;
}

function typeQuery(value: string): void {
  const target = input();
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the search overlay anatomy", () => {
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

  describe("the panel is opaque paper, not glass", () => {
    it("paints exactly one solid background, and no translucent film", () => {
      renderOverlay();
      const painted = Array.from(
        container!.querySelectorAll<HTMLElement>("[data-bg]")
      ).map((el) => el.dataset.bg);

      // The opaque paper layer itself, and nothing else painting a colour.
      expect(painted).toStrictEqual([mocks.colors.bgElev]);
      // Belt and braces: whatever is painted, none of it may carry alpha —
      // an `rgba(` tint film reads the same as one stacked under a backdrop
      // blur. (`expo-blur` is absent from the app entirely, so a live blur
      // cannot be reintroduced by accident.)
      for (const value of painted) expect(value).not.toMatch(/rgba\(/u);
    });
  });

  describe("try-chips are an empty-query-only affordance", () => {
    it("shows the try row while the query is empty", () => {
      renderOverlay();
      expect(container!.textContent).toContain("try");
      for (const label of mocks.suggestions)
        expect(container!.textContent).toContain(label);
    });

    it("hides the try row the moment there is a real query", () => {
      renderOverlay();
      typeQuery("a");
      expect(container!.textContent).not.toContain("Pemberton");
      expect(container!.textContent).not.toContain("right of way");
    });

    it("lays the chips on ONE row — nothing in the tree may flex-wrap", () => {
      renderOverlay();
      expect(
        container!.querySelectorAll('[data-flexwrap="wrap"]')
      ).toHaveLength(0);
    });
  });

  describe("the empty line", () => {
    it("is the exact spec copy, smart quotes included", () => {
      renderOverlay();
      typeQuery("pemberton");
      expect(container!.textContent).toContain(
        "Nothing across your apps matches “pemberton”."
      );
    });

    it("does not show on an empty query — there is nothing to not match", () => {
      renderOverlay();
      expect(container!.textContent).not.toContain(
        "Nothing across your apps matches"
      );
    });
  });

  describe("the fixed foot", () => {
    // The brief's note (:6022) leads with ↵ — a keyboard glyph. On a phone
    // only that glyph becomes its tap equivalent; every other word,
    // including the honesty clause, stays verbatim.
    const FOOT_NOTE =
      "tapping opens the owning app — record addressing is not built";

    it("is the exact two-part copy, with the tap verb instead of ↵", () => {
      renderOverlay();
      expect(container!.textContent).toContain("0 across 0 apps");
      expect(container!.textContent).toContain(FOOT_NOTE);
      expect(container!.textContent).not.toContain("↵");
    });

    it("stays present once a query is typed", () => {
      renderOverlay();
      typeQuery("pemberton");
      expect(container!.textContent).toContain("0 across 0 apps");
      expect(container!.textContent).toContain(FOOT_NOTE);
    });

    it("bounds the hint to its own trailing column so it can never run off-screen", () => {
      renderOverlay();
      const note = Array.from(container!.querySelectorAll("span")).find(
        (candidate) => candidate.textContent === FOOT_NOTE
      );
      expect(note).toBeTruthy();
      // `flex: 1` caps the note at the width the count leaves over (it wraps
      // inside that column), and right alignment keeps it pinned to the
      // trailing edge — the RN analogue of the brief's
      // `margin-inline-start: auto` (:3326).
      expect(note?.dataset.flex).toBe("1");
      expect(note?.dataset.textalign).toBe("right");
    });
  });

  describe("no app-filter row, no APPS grid, no RECENTS section", () => {
    it("renders exactly one scrollable region — the results list, not a second filter strip", () => {
      renderOverlay();
      typeQuery("pemberton");
      expect(container!.querySelectorAll("main")).toHaveLength(1);
    });

    it("renders no selectable chip state — the app-filter row's signature", () => {
      renderOverlay();
      typeQuery("pemberton");
      expect(container!.querySelectorAll("[aria-selected]")).toHaveLength(0);
    });

    it("never renders the invented section labels", () => {
      renderOverlay();
      typeQuery("pemberton");
      expect(container!.textContent).not.toContain("APPS");
      expect(container!.textContent).not.toContain("RECENTS");
      expect(container!.textContent).not.toContain("TRY SEARCHING FOR");
    });
  });

  describe("dismissal", () => {
    it("closes on a tap outside the field", () => {
      renderOverlay();
      const scrim = container!.querySelector('[aria-label="Close search"]');
      expect(scrim).toBeTruthy();
      act(() =>
        scrim!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("closes on Cancel", () => {
      renderOverlay();
      const cancel = Array.from(container!.querySelectorAll("button")).find(
        (candidate) => candidate.getAttribute("aria-label") === "Cancel search"
      );
      expect(cancel).toBeTruthy();
      act(() =>
        cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
