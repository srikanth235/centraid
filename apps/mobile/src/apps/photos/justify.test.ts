import { describe, expect, test } from "vitest";

import { GAP, aspectRatio, justify } from "./justify";
import type { PhotoAsset } from "./timeline-model";

function asset(id: string, width: number, height: number): PhotoAsset {
  return {
    id,
    uri: `file:///${id}.jpg`,
    previewUri: `file:///${id}.jpg`,
    originalUri: `file:///${id}.jpg`,
    capturedAt: "2026-08-04T10:00:00.000Z",
    kind: "photo",
    favorite: false,
    archived: false,
    deleted: false,
    backupState: "backed-up",
    source: "replica",
    width,
    height,
  };
}

// A realistic mixture: landscape, portrait, square, panorama.
const shapes: readonly [number, number][] = [
  [4032, 3024],
  [3024, 4032],
  [4032, 4032],
  [5760, 2160],
  [1920, 1080],
  [1080, 1920],
];

const library = (count: number): PhotoAsset[] =>
  Array.from({ length: count }, (_, index) => {
    const [w, h] = shapes[index % shapes.length]!;
    return asset(`a${index}`, w, h);
  });

describe("justified packing (handoff §4.1)", () => {
  test("full rows fill the content width exactly, edge to edge", () => {
    const rows = justify(library(60), 390, 120);
    // The trailing partial row is allowed to fall short; every row before it
    // must land on the container width to the pixel.
    for (const row of rows.slice(0, -1)) {
      const used =
        row.reduce((total, tile) => total + tile.width, 0) +
        GAP * (row.length - 1);
      expect(used).toBe(390);
    }
  });

  test("nothing is cropped to a square — tiles keep their real ratio", () => {
    const rows = justify(library(60), 390, 120);
    for (const row of rows.slice(0, -1)) {
      for (const tile of row) {
        const packed = tile.width / tile.height;
        // Only the last tile in a row absorbs the rounding remainder, so allow
        // a pixel of slack rather than demanding exact float equality.
        expect(Math.abs(packed - aspectRatio(tile.asset))).toBeLessThan(0.06);
      }
    }
  });

  test("every asset lands in exactly one row, in order", () => {
    const list = library(37);
    const flattened = justify(list, 390, 120).flat();
    expect(flattened.map((tile) => tile.asset.id)).toStrictEqual(
      list.map((item) => item.id)
    );
  });

  test("rows land around the target height rather than on it", () => {
    // A row that closes on a panorama is legitimately shorter than the target
    // — the target is what the packer aims at, not a height it enforces. What
    // must hold is that the aim lands: the mean row height tracks the rung.
    const rows = justify(library(60), 390, 120).slice(0, -1);
    const mean =
      rows.reduce((total, row) => total + row[0]!.height, 0) / rows.length;
    expect(mean).toBeGreaterThan(120 * 0.75);
    expect(mean).toBeLessThan(120 * 1.25);
  });

  test("a larger rung packs fewer tiles per row, and taller ones", () => {
    const list = library(60);
    const small = justify(list, 390, 64);
    const large = justify(list, 390, 168);
    // Fewer tiles per row means MORE rows for the same library — that is what
    // "bigger tiles" means on a fixed-width surface.
    expect(large.length).toBeGreaterThan(small.length);
    expect(large[0]!.length).toBeLessThan(small[0]!.length);
    expect(large[0]![0]!.height).toBeGreaterThan(small[0]![0]!.height);
  });

  test("the trailing partial row keeps its natural height, capped", () => {
    const rows = justify(library(4), 390, 120);
    const last = rows.at(-1)!;
    expect(last[0]!.height).toBeLessThanOrEqual(120 * 1.25);
  });

  test("an asset with no recorded dimensions is treated as square", () => {
    const unknown: PhotoAsset = {
      ...asset("u", 0, 0),
      width: undefined,
      height: undefined,
    };
    expect(aspectRatio(unknown)).toBe(1);
  });

  test("gutters are 2px, both axes", () => {
    expect(GAP).toBe(2);
  });

  test("packing 50k assets stays inside the cold-grid budget", () => {
    // The house scale test (`timeline-50k.test.ts`) covers grouping and
    // merging; packing is now on the same hot path and must not regress it.
    const list = library(50_000);
    const started = process.cpuUsage();
    const rows = justify(list, 390, 120);
    const elapsed = process.cpuUsage(started);
    expect((elapsed.user + elapsed.system) / 1_000).toBeLessThan(1_000);
    expect(rows.flat()).toHaveLength(50_000);
  });
});
