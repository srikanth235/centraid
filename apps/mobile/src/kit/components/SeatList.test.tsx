// The seat's one virtualised list (#922 E6). Three rules, each of which the
// five surfaces it replaced got wrong in at least one place:
//
//  - EVERY ROW IS DRAWN THROUGH THE LIST, keyed by the caller's own key. The
//    `.map()` bodies this replaced mounted every row a read returned, which is
//    a year-3 roster held whole once #922 0a stopped capping reads silently.
//  - AN EMPTY SET IS A STATE OF THE LIST, not its absence: the header and the
//    footer still draw. Three of the five screens branched around the list
//    entirely and lost their filter chips with the last row.
//  - ANCHORING REACHES THE LIST. It is a required prop with no default, and a
//    version that accepted one and dropped it on the floor would look exactly
//    like this one from the outside (docs/traps/list-anchoring.md).
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import { NEWEST_FIRST_ANCHORING } from "./list-anchoring";
import SeatList from "./SeatList";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});

/** The recycling list itself is Maestro's; what a stub can see is which props
 *  reached it and what it was asked to draw. */
const seen = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock(import("@shopify/flash-list"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.flashListStub(
    seen.props
  ) as unknown as typeof import("@shopify/flash-list");
});

interface Row {
  id: string;
}

function render(rows: readonly Row[]): HTMLElement {
  return mountBlock(
    <SeatList
      accessibilityLabel="The roster"
      anchoring={NEWEST_FIRST_ANCHORING}
      rows={rows}
      keyOf={(row) => row.id}
      renderRow={(row) => <span>{row.id}</span>}
      header={<header>chips</header>}
      footer={<footer>window foot</footer>}
      empty={<em>Nothing matches</em>}
    />
  ).container;
}

describe("the seat's one virtualised list", () => {
  afterEach(() => {
    // In place: the stub closed over this array when the module was mocked.
    seen.props.length = 0;
  });

  it("draws every row through the list under the caller's key", () => {
    const container = render([{ id: "a" }, { id: "b" }, { id: "c" }]);

    expect(
      nodesOf(container, "div")
        .map((node) => node.dataset.row)
        .filter((key) => key !== undefined)
    ).toStrictEqual(["a", "b", "c"]);
    expect(nodesOf(container, "em")).toHaveLength(0);
  });

  it("keeps the header and the footer when there is nothing to draw", () => {
    const container = render([]);

    expect(nodesOf(container, "em")[0]?.textContent).toBe("Nothing matches");
    expect(nodesOf(container, "header")).toHaveLength(1);
    expect(nodesOf(container, "footer")).toHaveLength(1);
  });

  it("hands the list its anchoring and its accessible name", () => {
    const container = render([{ id: "a" }]);

    expect(seen.props[0]?.maintainVisibleContentPosition).toBe(
      NEWEST_FIRST_ANCHORING
    );
    expect(nodesOf(container, "div")[0]?.dataset.role).toBe("list");
  });
});
