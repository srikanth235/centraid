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

  it("keeps a fact's caveat under the fact it qualifies", () => {
    const container = render(
      <PanelBlock
        facts={[
          {
            key: "harness runs",
            note: "Measured, not limited by Conserve.",
            value: "3 runs · 9.0s active",
          },
          { key: "sweeps", value: "2 passes" },
        ]}
      />
    );
    const spans = nodesOf(container, "span");
    expect(spans.map((node) => node.textContent)).toStrictEqual([
      "harness runs",
      "3 runs · 9.0s active",
      "Measured, not limited by Conserve.",
      "sweeps",
      "2 passes",
    ]);
    // The caveat is a sentence and leaves the numeric register.
    expect(styleOf(spans[2] ?? null).color).toBe(colors.textFaint);
    expect(styleOf(spans[2] ?? null).fontVariant).toBeUndefined();
  });

  it("promotes one fact to the display rung, over a qualifier line", () => {
    const container = render(
      <PanelBlock
        figure={{
          label: "At least · 30 days",
          qualifier: "1 unpriced.",
          value: "$3.40",
        }}
      />
    );
    const spans = nodesOf(container, "span");
    expect(spans.map((node) => node.textContent)).toStrictEqual([
      "At least · 30 days",
      "$3.40",
      "1 unpriced.",
    ]);
    // The display rung is the whole mechanism — the same string at the fact
    // rung is one 13pt value among thirty.
    const factRung = styleOf(spans[0] ?? null).fontSize as number;
    expect(styleOf(spans[1] ?? null).fontSize).toBeGreaterThan(factRung);
    // …and it is still a number: tabular figures, from the numeric role.
    expect(styleOf(spans[1] ?? null).fontVariant).toStrictEqual([
      "tabular-nums",
    ]);
  });

  it("tones a figure that is bad news, and draws no empty qualifier", () => {
    const container = render(
      <PanelBlock figure={{ label: "Failed", net: true, value: "12" }} />
    );
    const spans = nodesOf(container, "span");
    expect(spans).toHaveLength(2);
    expect(styleOf(spans[1] ?? null).color).toBe(colors.net);
  });

  it("renders nothing it was not given", () => {
    const container = render(<PanelBlock body="Facts only." />);
    expect(nodesOf(container, "span")).toHaveLength(1);
    expect(nodesOf(container, "button")).toHaveLength(0);
  });
});
