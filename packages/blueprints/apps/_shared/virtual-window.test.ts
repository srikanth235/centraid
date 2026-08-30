// The windowing primitive's arithmetic (#883 C4). Pure numbers, no renderer —
// the React binding's own obligations (focus survival, scroll wiring) are
// asserted where they can be seen, in `VirtualWindow.test.tsx`.
import { describe, expect, it } from "vitest";

import {
  indexAtOffset,
  measuredModel,
  modelCount,
  modelOffset,
  modelTotal,
  uniformModel,
  virtualItemAria,
  virtualRowAria,
  virtualSlice,
  wholeSlice,
} from "./virtual-window.ts";

const ROWS = uniformModel(9_999, 44);
const JUSTIFIED = measuredModel([120, 200, 80, 160, 240, 100]);

describe("height models", () => {
  it("answers a uniform run without allocating one number per row", () => {
    expect(modelCount(ROWS)).toBe(9_999);
    expect(modelOffset(ROWS, 0)).toBe(0);
    expect(modelOffset(ROWS, 100)).toBe(4_400);
    expect(modelTotal(ROWS)).toBe(439_956);
  });

  it("builds a prefix table whose last entry IS the total", () => {
    expect(modelCount(JUSTIFIED)).toBe(6);
    expect(modelOffset(JUSTIFIED, 0)).toBe(0);
    expect(modelOffset(JUSTIFIED, 3)).toBe(400);
    // `count` is a legal index and answers the total, so no consumer has to
    // special-case the end of the list.
    expect(modelOffset(JUSTIFIED, 6)).toBe(modelTotal(JUSTIFIED));
    expect(modelTotal(JUSTIFIED)).toBe(900);
  });

  it("clamps an out-of-range index rather than reading past the table", () => {
    expect(modelOffset(JUSTIFIED, -5)).toBe(0);
    expect(modelOffset(JUSTIFIED, 99)).toBe(900);
  });

  it("finds the block containing a pixel, on both shapes", () => {
    expect(indexAtOffset(ROWS, 0)).toBe(0);
    expect(indexAtOffset(ROWS, 43)).toBe(0);
    expect(indexAtOffset(ROWS, 44)).toBe(1);
    expect(indexAtOffset(ROWS, 1_000_000)).toBe(9_998);
    // Binary search over the measured table: 400 is the top edge of block 3.
    expect(indexAtOffset(JUSTIFIED, 399)).toBe(2);
    expect(indexAtOffset(JUSTIFIED, 400)).toBe(3);
    expect(indexAtOffset(JUSTIFIED, 899)).toBe(5);
  });

  it("answers an empty model without throwing", () => {
    const none = measuredModel([]);
    expect(modelCount(none)).toBe(0);
    expect(modelTotal(none)).toBe(0);
    expect(indexAtOffset(none, 500)).toBe(0);
  });
});

describe("the window a scroll position asks for", () => {
  const slice = (scrollTop: number, extra = {}) =>
    virtualSlice({
      model: ROWS,
      scrollTop,
      viewport: 880,
      overscan: 0,
      ...extra,
    });

  it("mounts the viewport and nothing else", () => {
    const window = slice(0);
    expect(window.start).toBe(0);
    expect(window.end).toBe(21); // 880 / 44 = 20 rows, plus the partial one
    expect(window.padStart).toBe(0);
    expect(window.end - window.start).toBeLessThan(30);
  });

  it("keeps the scrollbar exact: the pads plus the mounted rows are the whole set", () => {
    const window = slice(100_000);
    const mounted =
      modelOffset(ROWS, window.end) - modelOffset(ROWS, window.start);
    expect(window.padStart + mounted + window.padEnd).toBe(modelTotal(ROWS));
  });

  it("costs the same at the end of a 9,999-row roster as at the start", () => {
    const top = slice(0);
    const bottom = slice(modelTotal(ROWS) - 880);
    expect(bottom.end - bottom.start).toBeLessThanOrEqual(
      top.end - top.start + 1
    );
    expect(bottom.end).toBe(9_999);
    expect(bottom.padEnd).toBe(0);
  });

  it("widens the window by the overscan, both ways", () => {
    const tight = slice(44_000);
    const loose = slice(44_000, { overscan: 880 });
    expect(loose.start).toBeLessThan(tight.start);
    expect(loose.end).toBeGreaterThan(tight.end);
  });

  // The one that matters: unmounting the focused element drops focus to
  // `<body>` and ends keyboard navigation without saying so.
  it("keeps a pinned block mounted however far it has scrolled away", () => {
    const window = slice(100_000, { pinned: [3] });
    expect(window.start).toBe(3);
    expect(window.padStart).toBe(modelOffset(ROWS, 3));
    // Pinned or not, the row is at its own offset — never relocated.
    const mounted =
      modelOffset(ROWS, window.end) - modelOffset(ROWS, window.start);
    expect(window.padStart + mounted + window.padEnd).toBe(modelTotal(ROWS));
  });

  it("pins forward as well, and ignores a pin outside the set", () => {
    expect(slice(0, { pinned: [500] }).end).toBe(501);
    expect(slice(0, { pinned: [-1, 99_999, 1.5] }).end).toBe(21);
  });

  it("bounds the first paint instead of rendering everything unmeasured", () => {
    const unmeasured = virtualSlice({
      model: ROWS,
      scrollTop: 0,
      viewport: 0,
      overscan: 0,
      fallbackViewport: 1_200,
    });
    expect(unmeasured.end).toBe(28);
  });

  it("mounts nothing for an empty set and everything for a whole slice", () => {
    expect(
      virtualSlice({
        model: measuredModel([]),
        scrollTop: 0,
        viewport: 880,
        overscan: 0,
      })
    ).toStrictEqual({ start: 0, end: 0, padStart: 0, padEnd: 0 });
    expect(wholeSlice(JUSTIFIED)).toStrictEqual({
      start: 0,
      end: 6,
      padStart: 0,
      padEnd: 0,
    });
  });

  // A list rendered below a header scrolls into view from a negative offset.
  it("treats a not-yet-reached list as its own first block, not as an error", () => {
    const window = slice(-4_000);
    expect(window.start).toBe(0);
    expect(window.end).toBeGreaterThanOrEqual(1);
  });
});

describe("aria", () => {
  it("states the TRUE size and position, never the mounted count", () => {
    expect(virtualItemAria(4_200, 9_999)).toStrictEqual({
      "aria-setsize": 9_999,
      "aria-posinset": 4_201,
    });
    expect(virtualRowAria(0)).toStrictEqual({ "aria-rowindex": 1 });
  });
});
