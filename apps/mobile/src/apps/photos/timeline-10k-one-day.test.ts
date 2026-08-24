// The degenerate twin of timeline-50k.test.ts (#721/C1): not 50k
// captures spread over years, but 10k captures crammed into ONE calendar day
// — the "shot a wedding, imported the whole card at once" burst a real device
// actually produces. sectionPhotoAssets must still resolve it to a single
// bucket in one pass (no per-asset day fan-out to amortize against), and the
// justified-row packer must still lay out that one bucket's tiles in linear
// time rather than rediscovering quadratic behavior on a single giant row
// group. Colocated rather than folded into timeline-50k.test.ts: that file
// owns the "wide, sparse" cold-grid budget, this one owns the "narrow, dense"
// one, and the two budgets should be free to diverge without editing each
// other's assertions.

import { describe, expect, test } from "vitest";

import { justify } from "./justify";
import { makePhotosFixture } from "./photos-fixtures";
import { sectionPhotoAssets } from "./timeline-model";

function measureCpuMs<T>(run: () => T): { value: T; elapsedMs: number } {
  // CPU time, not wall clock — see timeline-50k.test.ts's own note: this
  // package runs alongside several other affected packages in PR checks, and
  // CPU time is immune to the OS descheduling this worker under that load.
  const started = process.cpuUsage();
  const value = run();
  const elapsed = process.cpuUsage(started);
  return { value, elapsedMs: (elapsed.user + elapsed.system) / 1_000 };
}

describe("timeline-10k-one-day", () => {
  test("10k captures inside one calendar day still section into a single bucket, cheaply", () => {
    const fixture = makePhotosFixture("ten-k-one-day");
    expect(fixture.assets).toHaveLength(10_000);
    const { value: sections, elapsedMs } = measureCpuMs(() =>
      sectionPhotoAssets(fixture.assets)
    );
    expect(elapsedMs).toBeLessThan(500);
    // One day in, one section out — the whole point of the fixture is that
    // there is nowhere else for these 10k rows to land.
    expect(sections).toHaveLength(1);
    expect(sections[0]?.day).toBe("2026-08-06");
    expect(sections[0]?.assets).toHaveLength(10_000);
  });

  test("justifying the resulting 10k-tile day stays inside the packing budget", () => {
    const fixture = makePhotosFixture("ten-k-one-day");
    const { value: rows, elapsedMs } = measureCpuMs(() =>
      justify(fixture.assets, 390, 120)
    );
    expect(elapsedMs).toBeLessThan(500);
    expect(rows.flat()).toHaveLength(10_000);
    // Every row fills the container width (modulo the trailing partial row),
    // exactly as justify.test.ts pins for the small-n case — a degenerate
    // single-day input must not be a second code path with its own bugs.
    for (const row of rows.slice(0, -1)) {
      const rowWidth =
        row.reduce((sum, tile) => sum + tile.width, 0) + 2 * (row.length - 1);
      expect(rowWidth).toBe(390);
    }
  });
});
