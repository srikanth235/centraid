// One RN stub for every kit-block test (#765); spread it:
//   vi.mock(import("react-native"), async () =>
//     (await import("../../test/react-native-stub")).reactNativeStub());
// Theme NOT stubbed: tests assert the real lowered token; style rides `data-style`.

import React, { act } from "react";
import { createRoot } from "react-dom/client";

type Props = Record<string, unknown> & { children?: React.ReactNode };

/** Collapse RN array/nested style to applied values. */
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

/** Node's flattened style, read off `data-style`. */
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
    // For assertions; invisible on screen.
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

/** Stubbed module object; spread into the factory above. */
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

/** AsyncStorage stub for the Appearance store import. */
export function asyncStorageStub(): { default: Record<string, unknown> } {
  return {
    default: {
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.resolve(),
      removeItem: () => Promise.resolve(),
    },
  };
}

/** `FlatList`, for a screen that windows (#883); spread it BESIDE
 *  `reactNativeStub()`. */
export function flatListStub(): Record<string, unknown> {
  return {
    FlatList: (props: Props & { data?: unknown[] }) => {
      const data = props.data ?? [];
      const render = props.renderItem as (info: {
        item: unknown;
        index: number;
      }) => React.ReactNode;
      const keyOf = props.keyExtractor as
        | ((item: unknown, index: number) => string)
        | undefined;
      return React.createElement(
        "div",
        {},
        props.ListHeaderComponent as React.ReactNode,
        data.length === 0
          ? (props.ListEmptyComponent as React.ReactNode)
          : data.map((item, index) =>
              React.createElement(
                React.Fragment,
                { key: keyOf?.(item, index) ?? String(index) },
                render({ index, item })
              )
            ),
        props.ListFooterComponent as React.ReactNode
      );
    },
  };
}

/** `react-native-svg`, for blocks reaching the icon set. */
export function svgStub(): Record<string, unknown> {
  const glyph = (props: Props) =>
    React.createElement("svg", { "data-glyph": true }, props.children);
  return { default: glyph, Path: () => null, Svg: glyph };
}

/** Mount a block into a jsdom container. */
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

/** Rendered nodes of one stubbed primitive, document order. */
export function nodesOf(container: HTMLElement, tag: string): HTMLElement[] {
  return [...container.querySelectorAll(tag)] as HTMLElement[];
}

/** Fire a stubbed `onPress`. */
export function press(node: Element | null | undefined): void {
  act(() => {
    (node as HTMLElement | null)?.click();
  });
}
