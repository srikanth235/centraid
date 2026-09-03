import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { iconChipFinish } from "@centraid/design";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import AppMark from "./AppMark";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});

const colors = resolveTheme("light").colors;

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

describe(AppMark, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("uses the handoff hue wash and a single-tone icon mark", () => {
    const container = render(
      <AppMark color="#167f8f" iconKey="Folder" size={32} testID="docs-mark" />
    );
    const [mark] = nodesOf(container, "div");
    const style = styleOf(mark);
    expect(mark?.dataset.testid).toBe("docs-mark");
    expect(style.backgroundColor).toBe(
      iconChipFinish("#167f8f", colors.bg, "light").backgroundColor
    );
    expect(style.width).toBe(32);
    expect(style.height).toBe(32);
    expect(style.borderRadius).toBeGreaterThan(0);
    expect(nodesOf(container, "svg")).toHaveLength(1);
  });

  it("recedes only the mark when the app is unavailable locally", () => {
    const container = render(
      <AppMark
        color="#167f8f"
        iconKey="Folder"
        muted
        size={28}
        testID="muted-mark"
      />
    );
    const [mark] = nodesOf(container, "div");
    expect(styleOf(mark).backgroundColor).toBe(colors.bgSunken);
  });
});
// @vitest-environment jsdom
