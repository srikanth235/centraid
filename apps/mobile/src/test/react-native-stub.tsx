// One React Native stub, shared by every kit-block test (#765 stage 1).
//
// The kit's block tests run in the plain node project (only PhotosHome.test.tsx
// gets the real Metro-transformed renderer), so each of them mocks
// `react-native` the way `AnchoredMenu.test.tsx` and `SearchOverlay.test.tsx`
// already do. Eleven copies of that mock would be eleven chances for one of
// them to drift into stubbing a primitive differently from the surface under
// test, so the mock lives here once and every test spreads it:
//
//   vi.mock(import("react-native"), async () =>
//     (await import("../../test/react-native-stub")).reactNativeStub());
//
// `useTheme()` reaches the Appearance preference, which reaches AsyncStorage,
// so a block test stubs that module too (`asyncStorageStub()` below) — the
// same one-liner `lib/daily-brief.test.ts` already writes.
//
// The theme is deliberately NOT stubbed: `@centraid/design/native` resolves
// under vitest (see `kit/theme/native.test.ts`), so a block test asserts the
// REAL lowered token — a 44pt row, an 11px floor, the `net` ink — rather than
// a fixture that would pass whatever the component happened to render.
//
// Style is carried onto the DOM as a serialized `data-style` attribute instead
// of a real DOM `style`, so a test can read a flattened React Native style
// (including values React DOM would reject, like `fontVariant: [...]`) exactly
// as the renderer would see it.

import React, { act } from "react";
import { createRoot } from "react-dom/client";

type Props = Record<string, unknown> & { children?: React.ReactNode };

/** Collapse RN's array/nested style into the one record the renderer applies. */
export function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => Object.assign(acc, flattenStyle(entry)),
      {}
    );
  }
  if (typeof style === "object") return style as Record<string, unknown>;
  return {};
}

/** The flattened style a rendered node carried, read back off `data-style`. */
export function styleOf(
  node: HTMLElement | null | undefined
): Record<string, unknown> {
  const raw = node?.dataset.style;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function domProps(props: Props): Props {
  const {
    accessibilityHint,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    accessibilityValue,
    children,
    numberOfLines,
    onPress,
    style,
    testID,
    ...rest
  } = props;
  const state = accessibilityState as
    | { disabled?: boolean; selected?: boolean }
    | undefined;
  void rest;
  const flat = flattenStyle(
    typeof style === "function"
      ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : style
  );
  return {
    children,
    "data-style": JSON.stringify(flat),
    ...(typeof accessibilityLabel === "string"
      ? { "aria-label": accessibilityLabel }
      : {}),
    // Surfaced so a test can assert it: the hint is what distinguishes ten
    // identical verbs for a screen reader, and it is invisible on screen.
    ...(typeof accessibilityHint === "string"
      ? { "data-hint": accessibilityHint }
      : {}),
    ...(typeof accessibilityRole === "string"
      ? { "data-role": accessibilityRole }
      : {}),
    ...(state?.disabled === undefined
      ? {}
      : { "aria-disabled": String(state.disabled) }),
    ...(state?.selected === undefined
      ? {}
      : { "aria-selected": String(state.selected) }),
    ...(accessibilityValue === undefined
      ? {}
      : { "data-value": JSON.stringify(accessibilityValue) }),
    ...(numberOfLines === undefined
      ? {}
      : { "data-lines": String(numberOfLines) }),
    ...(typeof testID === "string" ? { "data-testid": testID } : {}),
    ...(typeof onPress === "function" ? { onClick: onPress } : {}),
  };
}

function host(tag: string, props: Props): React.JSX.Element {
  const { children, ...rest } = domProps(props);
  return React.createElement(tag, rest, children);
}

class StubAnimatedValue {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  setValue(next: number): void {
    this.value = next;
  }
}

const noopAnimation = {
  start: (callback?: () => void) => callback?.(),
  stop: () => undefined,
  reset: () => undefined,
};

/** The stubbed module object. Spread into a `vi.mock` factory. */
export function reactNativeStub(): Record<string, unknown> {
  const Animated = {
    View: (props: Props) => host("div", props),
    Text: (props: Props) => host("span", props),
    Value: StubAnimatedValue,
    timing: () => noopAnimation,
    sequence: () => noopAnimation,
    loop: () => noopAnimation,
    delay: () => noopAnimation,
    parallel: () => noopAnimation,
  };
  return {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove: () => undefined }),
    },
    ActivityIndicator: (props: Props) => host("div", props),
    Animated,
    Easing: { inOut: () => undefined, ease: undefined },
    Modal: (props: Props & { visible?: boolean }) =>
      props.visible === false ? null : host("div", props),
    Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios },
    Pressable: (props: Props) => host("button", { type: "button", ...props }),
    ScrollView: (props: Props) => host("main", props),
    StyleSheet: {
      absoluteFill: {
        bottom: 0,
        left: 0,
        position: "absolute",
        right: 0,
        top: 0,
      },
      create: <T,>(styles: T): T => styles,
      flatten: flattenStyle,
    },
    Text: (props: Props) => host("span", props),
    TextInput: (props: Props) => host("input", props),
    useColorScheme: () => "light",
    useWindowDimensions: () => ({ height: 844, width: 390 }),
    View: (props: Props) => host("div", props),
  };
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The AsyncStorage stub the Appearance store needs to import. */
export function asyncStorageStub(): { default: Record<string, unknown> } {
  return {
    default: {
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.resolve(),
      removeItem: () => Promise.resolve(),
    },
  };
}

/** `react-native-svg`, for a block that reaches the icon set. */
export function svgStub(): Record<string, unknown> {
  const glyph = (props: Props) =>
    React.createElement("svg", { "data-glyph": true }, props.children);
  return { default: glyph, Path: () => null, Svg: glyph };
}

/** Mount a block into a jsdom container; returns it plus its unmount. */
export function mountBlock(node: React.ReactNode): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Every rendered node of one stubbed primitive, in document order. */
export function nodesOf(container: HTMLElement, tag: string): HTMLElement[] {
  return [...container.querySelectorAll(tag)] as HTMLElement[];
}

/** Fire a stubbed `onPress`. */
export function press(node: Element | null | undefined): void {
  act(() => {
    (node as HTMLElement | null)?.click();
  });
}
