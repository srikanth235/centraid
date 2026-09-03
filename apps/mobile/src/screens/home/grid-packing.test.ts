import { describe, expect, it } from "vitest";

import { MOBILE_COLUMNS, packTiles } from "./grid-packing";

type Size = "S" | "W";

const isWide = (size: Size): boolean => size === "W";

function holes(order: readonly Size[], columns = MOBILE_COLUMNS): number[] {
  const found: number[] = [];
  let seats = 0;
  order.forEach((size, index) => {
    if (isWide(size)) {
      if (seats > 0) found.push(index);
      seats = 0;
      return;
    }
    seats = (seats + 1) % columns;
  });
  return found;
}

describe(packTiles, () => {
  it("packs the seeded vault with no interior hole", () => {
    const observed: Size[] = ["W", "S", "W", "S", "S", "S", "W", "S"];
    expect(holes(observed)).not.toStrictEqual([]);

    const packed = packTiles(observed, isWide);
    expect(packed).toStrictEqual(["W", "S", "S", "W", "S", "S", "W", "S"]);
    expect(holes(packed)).toStrictEqual([]);
  });

  it("keeps every tile exactly once", () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const wide = (id: string): boolean => id === "a" || id === "d";
    expect([...packTiles(items, wide)].sort()).toStrictEqual([...items].sort());
  });

  it("is deterministic — the same content lays out the same way twice", () => {
    const items: Size[] = ["S", "W", "S", "S", "W", "S"];
    expect(packTiles(items, isWide)).toStrictEqual(packTiles(items, isWide));
  });

  it("only ever moves a small EARLIER, so a pinned app keeps the front", () => {
    const items = ["pinned-wide", "small-1", "wide", "small-2"];
    const wide = (id: string): boolean => id.includes("wide");
    expect(packTiles(items, wide)[0]).toBe("pinned-wide");
    expect(packTiles(items, wide)).toStrictEqual([
      "pinned-wide",
      "small-1",
      "small-2",
      "wide",
    ]);
  });

  it("leaves a lone trailing small alone — that is not a hole", () => {
    const items: Size[] = ["W", "S"];
    expect(packTiles(items, isWide)).toStrictEqual(["W", "S"]);
    expect(holes(packTiles(items, isWide))).toStrictEqual([]);
  });

  it("accepts a hole it cannot fill, rather than reshuffling the page", () => {
    const items: Size[] = ["S", "W", "W"];
    expect(packTiles(items, isWide)).toStrictEqual(["S", "W", "W"]);
  });

  it("changes nothing when there is nothing to pack", () => {
    expect(packTiles([], isWide)).toStrictEqual([]);
    expect(packTiles(["W", "W"] as Size[], isWide)).toStrictEqual(["W", "W"]);
    expect(packTiles(["S", "S", "S", "S"] as Size[], isWide)).toStrictEqual([
      "S",
      "S",
      "S",
      "S",
    ]);
  });

  it("fills a wider grid's row too — smalls pack in runs of `columns`", () => {
    const items: Size[] = ["S", "W", "S", "S", "S"];
    expect(packTiles(items, isWide, 3)).toStrictEqual([
      "S",
      "S",
      "S",
      "W",
      "S",
    ]);
    expect(holes(packTiles(items, isWide, 3), 3)).toStrictEqual([]);
  });
});
