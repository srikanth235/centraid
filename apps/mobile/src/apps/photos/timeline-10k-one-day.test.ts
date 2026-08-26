// Degenerate twin of timeline-50k.test.ts (#721/C1): 10k captures in ONE
// day; owns the narrow/dense budget, 50k the wide/sparse one.

import { describe, expect, test } from "vitest";

import { justify } from "./justify";
import { makePhotosFixture } from "./photos-fixtures";
import { sectionPhotoAssets } from "./timeline-model";

function measureCpuMs<T>(run: () => T): { value: T; elapsedMs: number } {
  // CPU time, not wall clock — immune to descheduling under load.
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
    // Rows fill container width as justify.test.ts pins.
    for (const row of rows.slice(0, -1)) {
      const rowWidth =
        row.reduce((sum, tile) => sum + tile.width, 0) + 2 * (row.length - 1);
      expect(rowWidth).toBe(390);
    }
  });
});
