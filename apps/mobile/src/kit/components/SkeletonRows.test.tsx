// The loading state (#765, spec §10). A skeleton breathes; it never spins —
// and it is drawn at the ROW BLOCK's own geometry, because the whole promise
// is that nothing reflows when the words arrive.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import SkeletonRows from "./SkeletonRows";

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

const colors = resolveTheme("light").colors;

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

describe(SkeletonRows, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("draws six rows at the row block's geometry", () => {
    const container = render(
      <SkeletonRows accessibilityLabel="Reading from the gateway" />
    );
    const divs = nodesOf(container, "div");
    const [block] = divs;
    expect(styleOf(block ?? null).backgroundColor).toBe(colors.bgElev);
    expect(block?.dataset.role).toBe("progressbar");
    expect(block?.getAttribute("aria-label")).toBe("Reading from the gateway");
    const rows = divs.filter((node) => styleOf(node).minHeight === 44);
    expect(rows).toHaveLength(6);
    expect(styleOf(rows[0] ?? null).borderTopWidth).toBe(0);
    expect(styleOf(rows[1] ?? null).borderTopWidth).toBe(1);
  });

  it("draws bones in the skeleton token, never a spinner", () => {
    const container = render(<SkeletonRows accessibilityLabel="Reading" />);
    const bones = nodesOf(container, "div").filter(
      (node) => styleOf(node).backgroundColor === colors.skel
    );
    expect(bones).toHaveLength(6);
    expect(styleOf(bones[0] ?? null).width).toBe("66%");
  });

  it("takes the row count the caller asked for", () => {
    const container = render(
      <SkeletonRows accessibilityLabel="Reading" rows={3} />
    );
    expect(
      nodesOf(container, "div").filter(
        (node) => styleOf(node).backgroundColor === colors.skel
      )
    ).toHaveLength(3);
  });
});
