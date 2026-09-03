import { describe, expect, it } from "vitest";

import { justify } from "./justify";
import {
  SKELETON_ASPECTS,
  skeletonRows,
  skeletonTileCount,
} from "./skeleton-rows";

const WIDTH = 390;
const TARGET = 120;

describe("the loading grid's geometry", () => {
  it("packs to the container width exactly, like every real row", () => {
    const rows = skeletonRows(WIDTH, TARGET, 40);
    for (const row of rows.slice(0, -1)) {
      const width =
        row.reduce((sum, tile) => sum + tile.width, 0) + 2 * (row.length - 1);
      expect(width).toBe(WIDTH);
    }
  });

  it("is byte-for-byte the same on every call — no randomness, no shimmer", () => {
    const first = skeletonRows(WIDTH, TARGET, 40);
    const second = skeletonRows(WIDTH, TARGET, 40);
    expect(second).toStrictEqual(first);
  });

  it("uses `justify()` itself, not a lookalike packer", () => {
    const rows = skeletonRows(WIDTH, TARGET, 12);
    const direct = justify(
      SKELETON_ASPECTS.map((aspect, index) => ({
        archived: false,
        backupState: "local-only" as const,
        capturedAt: "",
        deleted: false,
        favorite: false,
        height: 1000,
        id: `skeleton-${index}`,
        kind: "photo" as const,
        originalUri: "",
        previewUri: "",
        source: "device" as const,
        uri: "",
        width: Math.round(1000 * aspect),
      })),
      WIDTH,
      TARGET
    );
    expect(rows.map((row) => row.map((tile) => tile.width))).toStrictEqual(
      direct.map((row) => row.map((tile) => tile.width))
    );
  });

  it("draws a little more than fits, so the last row is cut by the edge", () => {
    const count = skeletonTileCount(WIDTH, TARGET, 700);
    const rows = skeletonRows(WIDTH, TARGET, count);
    const drawn = rows.reduce((sum, row) => sum + row[0]!.height + 2, 0);
    expect(drawn).toBeGreaterThan(700);
  });

  it("draws nothing at all before the container has a width", () => {
    expect(skeletonRows(0, TARGET, 40)).toStrictEqual([]);
    expect(skeletonRows(WIDTH, TARGET, 0)).toStrictEqual([]);
  });
});
