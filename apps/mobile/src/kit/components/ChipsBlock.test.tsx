// The chip row's one invariant (#765, spec §8): choosing a chip CANNOT reflow
// the row. The label bolds through the held pair — same size, same leading,
// different weight — and the pill's height is fixed at the touch floor, so a
// label that grew would break out of the pill rather than grow it.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import ChipsBlock from "./ChipsBlock";

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

const noop = (): void => undefined;

describe(ChipsBlock, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("bolds the active label without changing its metrics", () => {
    const container = render(
      <ChipsBlock
        chips={[
          { id: "all", label: "Everything", on: true, onPress: noop },
          { id: "risk", label: "High risk", onPress: noop },
        ]}
      />
    );
    const [on, off] = nodesOf(container, "span");
    const onStyle = styleOf(on ?? null);
    const offStyle = styleOf(off ?? null);
    expect(onStyle.fontSize).toBe(offStyle.fontSize);
    expect(onStyle.lineHeight).toBe(offStyle.lineHeight);
    expect(onStyle.fontFamily).not.toBe(offStyle.fontFamily);
  });

  // Stub tier: the computed style OBJECT and the state prop. A 44pt height in
  // a style is not a 44pt hit area on a device — that is a Maestro claim.
  it("declares the 44pt touch-floor height on every pill and marks the chosen one", () => {
    const container = render(
      <ChipsBlock
        chips={[{ id: "all", label: "All", on: true, onPress: noop }]}
      />
    );
    const [chip] = nodesOf(container, "button");
    expect(styleOf(chip ?? null).height).toBe(44);
    expect(styleOf(chip ?? null).borderColor).toBe(colors.text);
    expect(styleOf(chip ?? null).backgroundColor).toBe(colors.bgSunken);
    expect(chip?.getAttribute("aria-selected")).toBe("true");
  });

  it("swaps to the annotation pair with tabular figures for a window picker", () => {
    const container = render(
      <ChipsBlock
        mono
        chips={[
          { id: "7", label: "7 days", on: true, onPress: noop },
          { id: "30", label: "30 days", onPress: noop },
        ]}
      />
    );
    const [on, off] = nodesOf(container, "span");
    expect(styleOf(on ?? null).fontVariant).toStrictEqual(["tabular-nums"]);
    expect(styleOf(on ?? null).fontSize).toBe(styleOf(off ?? null).fontSize);
  });

  it("reports the chip that was chosen", () => {
    const picked: string[] = [];
    const container = render(
      <ChipsBlock
        chips={[
          { id: "a", label: "A", onPress: () => picked.push("a") },
          { id: "b", label: "B", onPress: () => picked.push("b") },
        ]}
      />
    );
    press(nodesOf(container, "button")[1]);
    expect(picked).toStrictEqual(["b"]);
  });
});
