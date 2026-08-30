// The row list's four rules (#765, spec §9), each of which has a cheap and
// wrong alternative a future edit will reach for:
//
//  - a row is a 44pt target, and rows are separated by a hairline — the FIRST
//    row draws none, because the container's own edge is its top
//  - the TITLE stays primary ink on a net-toned row; only the sub and the
//    state word take `net`
//  - the trailing verb is always OUTLINED (never a fill), and takes the
//    destructive recipe when the row is dangerous
//  - `off` recedes on the LEAF — disabled ink, a disabled button — never as a
//    container opacity
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
import RowsBlock from "./RowsBlock";

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

describe(RowsBlock, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  // Stub tier: the computed style OBJECT. A minHeight in a style is not a
  // measured hit area on a device — that is a Maestro claim.
  it("declares the 44pt touch-floor minHeight per row, and a rule on all but the first", () => {
    const container = render(
      <RowsBlock
        rows={[
          { key: "a", title: "Gmail" },
          { key: "b", title: "Calendar" },
        ]}
      />
    );
    // block > [row > [line > text]] per record.
    const [block, first, firstLine, , second] = nodesOf(container, "div");
    expect(styleOf(block ?? null).backgroundColor).toBe(colors.bgElev);
    expect(styleOf(first ?? null).borderTopWidth).toBe(0);
    expect(styleOf(firstLine ?? null).minHeight).toBe(44);
    expect(styleOf(second ?? null).borderTopWidth).toBe(1);
    expect(styleOf(second ?? null).borderTopColor).toBe(colors.line);
  });

  it("keeps the title in primary ink while the metadata goes net", () => {
    const container = render(
      <RowsBlock
        rows={[
          {
            key: "a",
            meta: "Lapsed",
            net: true,
            sub: "The connection lapsed on 9 August",
            title: "Re-authorize Gmail",
          },
        ]}
      />
    );
    const [title, sub, meta] = nodesOf(container, "span");
    expect(styleOf(title ?? null).color).toBe(colors.text);
    expect(styleOf(sub ?? null).color).toBe(colors.net);
    expect(styleOf(meta ?? null).color).toBe(colors.net);
  });

  it("draws the verb outlined, and destructive when the row is dangerous", () => {
    const container = render(
      <RowsBlock
        rows={[
          {
            action: { label: "Deny", onPress: noop },
            dangerous: true,
            key: "a",
            title: "Deny this write",
          },
        ]}
      />
    );
    const [button] = nodesOf(container, "button");
    const style = styleOf(button ?? null);
    expect(style.backgroundColor).toBe("transparent");
    expect(style.borderColor).toBe(colors.danger);
  });

  it("recedes an off row on its own leaves", () => {
    const container = render(
      <RowsBlock
        rows={[
          {
            action: { label: "Resume", onPress: noop },
            key: "a",
            off: true,
            title: "Home Assistant",
          },
        ]}
      />
    );
    const [title] = nodesOf(container, "span");
    const [button] = nodesOf(container, "button");
    expect(styleOf(title ?? null).color).toBe(colors.textDisabled);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(styleOf(button ?? null).opacity).toBeUndefined();
  });

  it("runs the row's own verb, and only it", () => {
    const calls: string[] = [];
    const container = render(
      <RowsBlock
        rows={[
          {
            action: { label: "Open", onPress: () => calls.push("a") },
            key: "a",
            title: "One",
          },
          {
            action: { label: "Open", onPress: () => calls.push("b") },
            key: "b",
            title: "Two",
          },
        ]}
      />
    );
    press(nodesOf(container, "button")[1]);
    expect(calls).toStrictEqual(["b"]);
  });

  it("renders a row's expansion under its own line, inside the same cell", () => {
    const container = render(
      <RowsBlock
        rows={[
          {
            children: <React.Fragment key="x" />,
            key: "a",
            title: "Staged write",
          },
        ]}
      />
    );
    // block > row > [line > text, expansion] — the expansion is a SIBLING of
    // the row's line, inside the same cell, so the divider still separates
    // one record from the next.
    const divs = nodesOf(container, "div");
    expect(divs).toHaveLength(5);
    expect(styleOf(divs[4] ?? null).paddingHorizontal).toBe(12);
  });
});
