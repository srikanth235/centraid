import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { generateVolumeFixture } from "@centraid/test-kit/volume-fixture";

import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";
import { exerciseWindowedBootstrap } from "../quality/replica-bootstrap-fixture.js";

const OWNER = "tests/scale/replica-bootstrap.scale.test.ts";

describe("replica-bootstrap.scale", () => {
  test("windowed bootstrap converges after an in-flight deletion at volume", async () => {
    const fixture = generateVolumeFixture({
      seed: 458,
      parties: 0,
      photos: 0,
      conversations: 0,
      replicaRows: 50_000,
    });
    // The volume fixture types row values as Record<string, unknown>; the
    // deterministic string/number values it emits are all valid ReplicaValues, so
    // bridge the two fixture shapes explicitly for the bootstrap harness.
    const source = fixture.replicaRows as unknown as Parameters<
      typeof exerciseWindowedBootstrap
    >[0];
    const result = await exerciseWindowedBootstrap(source, 2_000, 24_999);
    // #659 R4 — sustained-drift gate over this rig's own 30-sample
    // nightly history. Null until the history is deep enough; a null is
    // "no opinion yet", never a pass.
    const drift = await rigDriftBudgetMs("scale", OWNER);
    const passed =
      result.rows === 49_999 &&
      result.cursor.seq === 11 &&
      result.durationMs < 20_000;
    const withinDrift = drift === null || result.durationMs <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Replica convergence at 50k rows",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: result.durationMs,
          unit: "ms",
          budget: 20_000,
        },
        { name: "converged rows", value: result.rows, unit: "rows" },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${result.durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(result.rows).toBe(49_999);
    expect(result.cursor.seq).toBe(11);
    expect(result.durationMs).toBeLessThan(20_000);
  });
});
