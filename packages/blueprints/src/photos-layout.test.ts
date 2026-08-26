// v4 justified-row packing math (design_handoff_photos §4.1-4.2,
// apps/photos/layout.ts). Pure and DOM-free: straight coverage of `justify()`
// and the tile-size rung table, no app boot harness.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

interface Asset {
  asset_id: string;
  width?: number | null;
  height?: number | null;
}
interface JustifiedTile {
  asset: Asset;
  width: number;
  height: number;
}
interface RungTargets {
  desktop: number;
  phone: number;
}

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/photos/layout.ts")
).href;
const {
  justify,
  RUNGS,
  RUNG_LABELS,
  DEFAULT_RUNG,
  DEFAULT_ZOOM,
  ZOOM_LEVELS,
  rungHeight,
} = (await import(moduleUrl)) as {
  justify: (
    list: Asset[],
    containerWidth: number,
    targetHeight: number,
    gap?: number
  ) => JustifiedTile[][];
  RUNGS: readonly RungTargets[];
  RUNG_LABELS: readonly string[];
  DEFAULT_RUNG: number;
  DEFAULT_ZOOM: number;
  ZOOM_LEVELS: readonly number[];
  rungHeight: (rung: number, surface?: "desktop" | "phone") => number;
};

/** An asset carrying only what the packer reads: pixel `width`/`height`. */
const photo = (id: string, width: number, height: number): Asset => ({
  asset_id: id,
  width,
  height,
});

/** Sum of a row's tile widths plus the gaps between them. */
const rowSpan = (row: JustifiedTile[], gap: number): number =>
  row.reduce((s, t) => s + t.width, 0) + gap * (row.length - 1);

const GAP = 2;

describe("Photos justified packing (v4 §4.1)", () => {
  it("returns nothing for an empty list", () => {
    expect(justify([], 1000, 176)).toStrictEqual([]);
  });

  it("fills every full row's content width exactly, edge to edge", () => {
    const assets = Array.from({ length: 12 }, (_, i) =>
      photo(`a${i}`, 400 + (i % 5) * 60, 300)
    );
    const rows = justify(assets, 1000, 176);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) {
      expect(rowSpan(row, GAP)).toBe(1000);
    }
  });

  it("caps the trailing partial row at targetHeight * 1.25 without stretching it", () => {
    const rows = justify([photo("solo", 400, 300)], 1200, 176);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toBeDefined();
    const tile = row![0]!;
    expect(tile.height).toBeLessThanOrEqual(176 * 1.25);
    expect(rowSpan(row!, GAP)).toBeLessThan(1200);
  });

  it("does not stretch a trailing row that is a hair short of full", () => {
    // Four 4:3 photos sum just under a full 1000px row: last-row branch,
    // natural stretch height near (and below) the 1.25x cap.
    const assets = [
      photo("a", 400, 300),
      photo("b", 400, 300),
      photo("c", 400, 300),
      photo("d", 300, 300),
    ];
    const rows = justify(assets, 5000, 176);
    expect(rows).toHaveLength(1);
    for (const tile of rows[0]!) {
      expect(tile.height).toBeLessThanOrEqual(176 * 1.25);
    }
  });

  it("does not overflow the container on a single ultra-wide panorama", () => {
    const rows = justify([photo("pano", 4000, 400)], 800, 176);
    expect(rows).toHaveLength(1);
    expect(rowSpan(rows[0]!, GAP)).toBeLessThanOrEqual(800);
  });

  it("does not overflow on a single very tall portrait", () => {
    const rows = justify([photo("tall", 300, 4000)], 800, 176);
    expect(rows).toHaveLength(1);
    const tile = rows[0]![0]!;
    expect(tile.height).toBeLessThanOrEqual(176 * 1.25);
    expect(tile.width).toBeLessThan(800);
  });

  it("treats a missing or zero aspect ratio as square (1:1), never dividing by zero", () => {
    const rows = justify(
      [photo("noexif", 0, 0), photo("also-noexif", 0, 0)],
      1000,
      176
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const tile of row) {
        expect(Number.isFinite(tile.width)).toBe(true);
        expect(Number.isFinite(tile.height)).toBe(true);
      }
    }
  });

  describe("gap arithmetic", () => {
    it("fills the row exactly with a single closing tile (no interior gap to subtract)", () => {
      // One wide tile crossing the close-row threshold: a genuine one-tile
      // FULL row; no interior gap, so the span must land on 800 exactly.
      const rows = justify([photo("wide", 4000, 400)], 800, 176, 2);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveLength(1);
      expect(rowSpan(rows[0]!, 2)).toBe(800);
    });

    it("packs a two-tile row exactly, gap subtracted once", () => {
      // Two squares: the row closes exactly after the second tile at 300.
      const assets = [photo("a", 300, 300), photo("b", 300, 300)];
      const rows = justify(assets, 300, 176, 2);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveLength(2);
      expect(rowSpan(rows[0]!, 2)).toBe(300);
    });

    it("packs many full rows exactly with gaps subtracted (n-1) times each", () => {
      // 17 squares at 1200: uniform aspect closes every 8th tile; full rows
      // plus a genuine one-tile trailing remainder.
      const assets = Array.from({ length: 17 }, (_, i) =>
        photo(`m${i}`, 300, 300)
      );
      const rows = justify(assets, 1200, 176, 2);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows.slice(0, -1)) {
        expect(rowSpan(row, 2)).toBe(1200);
      }
    });

    it("honors a custom gap argument distinct from the module default", () => {
      const assets = Array.from({ length: 6 }, (_, i) =>
        photo(`g${i}`, 400, 300)
      );
      const tightRows = justify(assets, 1000, 176, 0);
      const wideRows = justify(assets, 1000, 176, 10);
      for (const row of tightRows.slice(0, -1)) {
        expect(rowSpan(row, 0)).toBe(1000);
      }
      for (const row of wideRows.slice(0, -1)) {
        expect(rowSpan(row, 10)).toBe(1000);
      }
    });
  });

  it("is stable: identical input yields identical output", () => {
    const assets = Array.from({ length: 20 }, (_, i) =>
      photo(`s${i}`, 300 + (i % 7) * 40, 250 + (i % 3) * 30)
    );
    const first = justify(assets, 1100, 176);
    const second = justify(assets, 1100, 176);
    expect(second).toStrictEqual(first);
    // Fresh structurally identical clones: no hidden state keyed on identity.
    const clones = assets.map((a) => ({ ...a }));
    const third = justify(clones, 1100, 176);
    expect(third.map((r) => r.map((t) => [t.width, t.height]))).toStrictEqual(
      first.map((r) => r.map((t) => [t.width, t.height]))
    );
  });

  it.each([0, 1, 2, 3] as const)("packs correctly at rung index %i", (rung) => {
    const targetHeight = rungHeight(rung, "desktop");
    const assets = Array.from({ length: 10 }, (_, i) =>
      photo(`r${rung}-${i}`, 400 + (i % 4) * 50, 300)
    );
    const rows = justify(assets, 1000, targetHeight);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows.slice(0, -1)) {
      expect(rowSpan(row, GAP)).toBe(1000);
    }
    for (const row of rows) {
      for (const tile of row) {
        expect(tile.height).toBeLessThanOrEqual(targetHeight * 1.25 + 1);
      }
    }
  });
});

describe("Photos tile-size rungs (v4 §4.2)", () => {
  it("has exactly four rungs, XS through L, in order", () => {
    expect(RUNGS).toHaveLength(4);
    expect(RUNG_LABELS).toStrictEqual(["XS", "S", "M", "L"]);
  });

  it("matches the handoff's desktop/PWA and phone target pixels", () => {
    expect(RUNGS.map((r) => r.desktop)).toStrictEqual([92, 128, 176, 248]);
    expect(RUNGS.map((r) => r.phone)).toStrictEqual([64, 88, 120, 168]);
  });

  it("defaults to rung M (index 2)", () => {
    expect(DEFAULT_RUNG).toBe(2);
    expect(RUNG_LABELS[DEFAULT_RUNG]).toBe("M");
  });

  it("exposes a single stored index that resolves to different pixels per surface", () => {
    for (let rung = 0; rung < RUNGS.length; rung++) {
      expect(rungHeight(rung, "desktop")).toBe(RUNGS[rung]!.desktop);
      expect(rungHeight(rung, "phone")).toBe(RUNGS[rung]!.phone);
    }
    // Same index, different pixel heights per surface: the index, not a
    // pixel value, is what persists.
    expect(rungHeight(DEFAULT_RUNG, "desktop")).not.toBe(
      rungHeight(DEFAULT_RUNG, "phone")
    );
  });

  it("keeps this blueprint's desktop/PWA zoom control walking the same table", () => {
    expect(ZOOM_LEVELS).toStrictEqual(RUNGS.map((r) => r.desktop));
    expect(DEFAULT_ZOOM).toBe(DEFAULT_RUNG);
  });
});
