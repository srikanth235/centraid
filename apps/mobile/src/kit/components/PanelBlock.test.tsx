// The panel's two claims (#765, spec §9):
//
//  - a FACT has a key column of a fixed width (the touch value, 110), so the
//    values line up down the list instead of stepping in and out; the key is
//    uppercase micro and the value carries tabular figures
//  - `tone` colours the EDGE. `net` is a border, never a fill — the one
//    chromatic ink in the system does not get to own a rectangle
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import PanelBlock from "./PanelBlock";

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

const noop = (): void => undefined;

describe(PanelBlock, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("pins the fact key column and types both halves", () => {
    const container = render(
      <PanelBlock facts={[{ key: "to", value: "tom@pemberton.example" }]} />
    );
    const [key, value] = nodesOf(container, "span");
    expect(styleOf(key ?? null).width).toBe(110);
    expect(styleOf(key ?? null).textTransform).toBe("uppercase");
    expect(styleOf(value ?? null).fontVariant).toStrictEqual(["tabular-nums"]);
    expect(styleOf(value ?? null).color).toBe(colors.text);
  });

  it("spends net on the edge, never on a ground", () => {
    const container = render(
      <PanelBlock body="Could not reach it." tone="net" />
    );
    const [panel] = nodesOf(container, "div");
    expect(styleOf(panel ?? null).borderColor).toBe(colors.net);
    expect(styleOf(panel ?? null).backgroundColor).toBe(colors.bgElev);
  });

  it("takes the seam edge for the one page that is about other machines", () => {
    const container = render(<PanelBlock body="Pending." tone="seam" />);
    expect(styleOf(nodesOf(container, "div")[0] ?? null).borderColor).toBe(
      colors.seam
    );
  });

  it("carries at most one filled commit beside one quiet verb", () => {
    const container = render(
      <PanelBlock
        // `filled` is explicit, and that is the point: a panel verb is
        // outlined unless the panel carries the view's ONE commit. The shell's
        // twin of this panel passes the same flag.
        action={{ filled: true, label: "Approve and send", onPress: noop }}
        action2={{ label: "Edit and approve", onPress: noop }}
        title="The survey came back"
      />
    );
    const [commit, quiet] = nodesOf(container, "button");
    expect(styleOf(commit ?? null).backgroundColor).toBe(colors.accentFill);
    expect(styleOf(quiet ?? null).backgroundColor).toBe("transparent");
  });

  it("renders nothing it was not given", () => {
    const container = render(<PanelBlock body="Facts only." />);
    expect(nodesOf(container, "span")).toHaveLength(1);
    expect(nodesOf(container, "button")).toHaveLength(0);
  });
});
