// @vitest-environment jsdom
// #1015 D6/B15 — Settings had no door from Home. It was reachable only through
// All apps, which a member standing on the springboard has no reason to open,
// and the one More row that WAS a dead end (Starred) could still be pinned into
// a band slot. The cover's trailing control is the door.
//
// Same react-native-as-DOM technique as `PlacesView.test.tsx`.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HomeTitleRow from "./HomeTitleRow";
import { PLACES } from "./places";

type ReactNative = typeof import("react-native");
type ThemeModule = typeof import("../../kit/theme");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const element = (
    tag: string,
    props: Record<string, unknown>
  ): React.ReactElement => ReactModule.createElement(tag, props);
  return {
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      children,
      onPress,
      testID,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      children?: React.ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      element("button", {
        "aria-label": accessibilityLabel,
        children,
        "data-testid": testID,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      }),
    StyleSheet: { create: <T,>(styles: T): T => styles },
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as unknown as Partial<ReactNative>;
});

vi.mock(
  import("../../kit/components/Icon"),
  () =>
    ({
      default: () => null,
    }) as never
);

vi.mock(
  import("../../kit/components/NativeText"),
  () =>
    ({
      Text: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("span", {}, children),
    }) as never
);

vi.mock(import("../../kit/theme"), async (importOriginal) => {
  const actual = await importOriginal<ThemeModule>();
  return {
    ...actual,
    useTheme: () => ({ colors: { line: "#line", text: "#text" } }),
  } as never;
});

let host: HTMLDivElement;
let root: Root;

describe("Home's cover row", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("carries Settings as its one control, named for a screen reader", () => {
    const onSettings = vi.fn<() => void>();
    act(() => root.render(<HomeTitleRow onSettings={onSettings} />));

    const buttons = [...host.querySelectorAll("button")];
    expect(
      buttons.map((node) => node.getAttribute("aria-label"))
    ).toStrictEqual(["Settings"]);

    act(() => buttons[0]!.click());
    expect(onSettings).toHaveBeenCalledOnce();
  });
});

describe("the places a band slot can hold", () => {
  it("has no place that navigates nowhere", () => {
    // Starred was the one row with no screen behind it, and `pin: false` did
    // not stop it: every place without `law` is offered in the pin sheet.
    expect(PLACES.map((place) => place.id)).not.toContain("starred");
    expect(PLACES.map((place) => place.id)).toContain("settings");
  });
});
