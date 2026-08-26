/**
 * The springboard grid's packing rule.
 *
 * The case this module exists for is `packs the seeded vault with no interior
 * hole` below: the exact size sequence a freshly seeded vault produces on
 * device, which renders three blank half-rows unpacked. `holes()` is the assertion that
 * matters — it walks the packed order the way the flex-wrap grid does and
 * counts the gaps a member would actually see.
 */
import { describe, expect, it } from "vitest";

import { MOBILE_COLUMNS, packTiles } from "./grid-packing";

type Size = "S" | "W";

const isWide = (size: Size): boolean => size === "W";

/**
 * Where a flex-wrap grid would leave a blank half-row, replaying its placement.
 *
 * A wide tile needs a whole row, so meeting one with a partly-filled row of
 * smalls leaves that row's remaining seats blank. Returns the index of every
 * such gap; a run of smalls left short at the very END is not counted, because
 * there is nothing left to pair it with.
 */
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
    // The exact order observed on device: Notes, People, Photos, Locker,
    // Tally, Tasks, Docs, Agenda.
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
    // `orderByPins` has already lifted "pinned" to the head; packing must not
    // demote it behind the small it pulls forward.
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
    // One small and no partner anywhere: the gap is a consequence of the
    // sizes, not of the order, so the order is left as it is.
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
