import { readFile } from "node:fs/promises";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import {
  blobLane,
  bootCompositeGateway,
  browseLane,
  gatewayDbBytes,
  median,
  mergeLanes,
  openDescriptorCount,
  searchLane,
  slopePerSample,
  syncLane,
  writeLane,
} from "../helpers/composite-workload.js";
import type { SoakSample } from "../helpers/composite-workload.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

/**
 * LONG-RUN SOAK (issue #842 W3.4).
 *
 * Everything else in the perf and scale lanes is a sprint: seed a fixture,
 * measure one pass, tear it down. A whole class of defect is invisible to a
 * sprint because it only shows up in the SECOND hour — a listener added per
 * request and never removed, a prepared-statement cache with no bound, a
 * journal that grows without being pruned, a temp file per upload that is never
 * unlinked, an event loop that gets a little slower every cycle. Those are the
 * defects an owner meets as "my machine is fine on Monday and hot on Friday",
 * and this repo had nothing that could see them.
 *
 * This rig runs the household workload in a LOOP against one long-lived
 * `serve()` gateway and watches five growth axes between cycles:
 *
 *   - memory        — RSS, heap, and the external/ArrayBuffer arenas where
 *                     blob and CAS buffers live
 *   - fd / handles  — open descriptors held by the process
 *   - DB bloat      — every SQLite file the gateway owns, including -wal/-shm
 *   - latency creep — per-cycle wall clock, first third vs last third
 *   - refusals      — a gateway that starts shedding load as it ages has
 *                     degraded even if every number above stayed flat
 *
 * ── Duration, and the honest limit of what runs here ────────────────────────
 *
 * `CENTRAID_SOAK_MINUTES` sets the wall-clock target; it defaults to a short
 * setting so the rig ALWAYS RUNS, including on the nightly scale lane. That is
 * deliberate and is the difference between a rig and a wish: a soak that only
 * existed behind an env var nobody sets is a lane that silently stopped
 * running, and a rig that skipped itself when the var is unset would be a
 * vacuous green. At the short default it proves the loop, the sampler and the
 * invariants all work, and it catches a gross leak.
 *
 * It does NOT prove the absence of a slow leak. Slope over ~45 s of cycles is
 * dominated by cache warming, so the GROWTH ceilings are asserted only at or
 * above `declaredSoakMinutes` (see tests/experience-budgets/gateway.json) —
 * exactly the pattern `restore-10gib.scale.test.ts` uses for its 10 GiB
 * ceilings. Below that the growth axes are measured and PUBLISHED but do not
 * gate, while the always-true invariants (every cycle completed, no transport
 * error, no untyped refusal, descriptors under an absolute ceiling) gate at
 * every duration. The real answer needs the weekly lane; see the BLOCKED
 * section in the receipt for this issue.
 *
 * Determinism: cycle workloads are seeded from the cycle index, never from the
 * clock. Elapsed time decides only WHEN TO STOP looping — never what work to
 * do — and there is no fixed sleep anywhere: each cycle waits on its own
 * requests, not on a timer.
 */
const OWNER = "tests/scale/long-run-soak.scale.test.ts";

/** Wall-clock target in minutes. The weekly lane sets this to hours. */
const SOAK_MINUTES = (() => {
  const raw = Number(process.env.CENTRAID_SOAK_MINUTES ?? "0.75");
  return Number.isFinite(raw) && raw > 0 ? raw : 0.75;
})();

/**
 * Cycles run even if the clock target is already met. Slope and first-third /
 * last-third medians need samples; nine post-warmup cycles is the floor at
 * which those statistics mean anything at all.
 */
const MIN_CYCLES = 12;
/**
 * Cycles discarded before the growth axes are computed. A fresh gateway fills
 * page cache, compiles statements and grows its WAL on the first passes; that
 * is start-up cost, not a leak, and including it would make every soak look
 * like it was leaking.
 */
const WARMUP_CYCLES = 3;
/** Ops per lane per cycle. Small: the axis under test is TIME, not volume. */
const OPS_PER_LANE = 3;
/**
 * Vitest per-test runaway guard — NOT a budget. The soak stops on its own
 * clock target; this only bounds a run that has stopped making progress, and
 * is sized for the weekly lane's multi-hour `CENTRAID_SOAK_MINUTES`.
 */
const RUNAWAY_GUARD_MS = 36_000_000;

interface CeilingFile {
  metrics: {
    soakDegradation: {
      declaredSoakMinutes: number;
      ceilingLatencyCreepFactor: number;
      ceilingRssGrowthBytesPerCycle: number;
      ceilingOpenDescriptors: number;
      ceilingDescriptorGrowth: number;
    };
  };
}

describe("long-run-soak.scale", () => {
  test(
    "a long-lived gateway under continuous household use does not creep in memory, descriptors, DB size or latency",
    async () => {
      const ceilings = (
        JSON.parse(
          await readFile("tests/experience-budgets/gateway.json", "utf8")
        ) as CeilingFile
      ).metrics.soakDegradation;
      const atDeclaredDuration = SOAK_MINUTES >= ceilings.declaredSoakMinutes;

      const gateway = await bootCompositeGateway("long-run-soak-");
      onTestFinished(() => gateway.close());

      const soakMs = SOAK_MINUTES * 60_000;
      const started = performance.now();
      const samples: SoakSample[] = [];
      const transportErrors: string[] = [];
      const refusals: Record<string, number> = {};

      // The loop condition reads the clock — the ONE legitimate use, and it
      // decides only when to stop, never what work to do. The workload for
      // cycle N is seeded from N.
      for (
        let cycle = 0;
        cycle < MIN_CYCLES || performance.now() - started < soakMs;
        cycle += 1
      ) {
        const cycleStarted = performance.now();
        const seed = 7_000 + cycle * 17;
        // oxlint-disable-next-line no-await-in-loop -- the loop IS the soak: cycle N+1 must observe the host state cycle N left behind
        const lanes = await Promise.all([
          syncLane(gateway, OPS_PER_LANE, 2),
          searchLane(gateway, OPS_PER_LANE, seed + 1, 2),
          writeLane(gateway, OPS_PER_LANE, seed + 2, 2),
          blobLane(gateway, OPS_PER_LANE, seed + 3, 64 * 1024, 2),
          browseLane(gateway, OPS_PER_LANE, seed + 4, 2),
        ]);
        const cycleMs = performance.now() - cycleStarted;
        const tally = mergeLanes(lanes);
        transportErrors.push(...tally.transportErrors);
        for (const [key, count] of Object.entries(tally.refusals))
          refusals[key] = (refusals[key] ?? 0) + count;
        const memory = process.memoryUsage();
        // oxlint-disable-next-line no-await-in-loop -- one host sample per completed cycle, in cycle order
        const [openDescriptors, dbBytes] = await Promise.all([
          openDescriptorCount(),
          gatewayDbBytes(gateway.dataDir),
        ]);
        samples.push({
          cycle,
          elapsedMs: performance.now() - started,
          cycleMs,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBufferBytes: memory.arrayBuffers,
          openDescriptors,
          dbBytes,
          ok: tally.ok,
          refused: tally.ops - tally.ok - tally.transportErrors.length,
        });
      }
      const totalMs = performance.now() - started;

      const measured = samples.slice(WARMUP_CYCLES);
      const third = Math.max(1, Math.floor(measured.length / 3));
      const firstThird = median(
        measured.slice(0, third).map((sample) => sample.cycleMs)
      );
      const lastThird = median(
        measured.slice(-third).map((sample) => sample.cycleMs)
      );
      const latencyCreepFactor =
        firstThird > 0 ? lastThird / firstThird : Number.NaN;
      const rssSlope = slopePerSample(measured.map((s) => s.rssBytes));
      const heapSlope = slopePerSample(measured.map((s) => s.heapUsedBytes));
      const arrayBufferSlope = slopePerSample(
        measured.map((s) => s.arrayBufferBytes)
      );
      const dbSlope = slopePerSample(measured.map((s) => s.dbBytes));
      const descriptors = measured
        .map((s) => s.openDescriptors)
        .filter((value): value is number => value !== null);
      const maxDescriptors = descriptors.length
        ? Math.max(...descriptors)
        : null;
      const descriptorGrowth =
        descriptors.length >= 2
          ? Math.max(...descriptors) - Math.min(...descriptors)
          : 0;

      const untyped = Object.keys(refusals).filter((key) =>
        key.endsWith("/untyped")
      );
      const totalOps = samples.reduce(
        (total, sample) => total + sample.ok + sample.refused,
        0
      );

      // Always-true invariants — these gate at EVERY duration.
      const invariantsHeld =
        samples.length >= MIN_CYCLES &&
        transportErrors.length === 0 &&
        untyped.length === 0 &&
        (maxDescriptors === null ||
          maxDescriptors <= ceilings.ceilingOpenDescriptors);
      // Growth ceilings — asserted only at or above the declared duration.
      const growthHeld =
        !atDeclaredDuration ||
        (latencyCreepFactor <= ceilings.ceilingLatencyCreepFactor &&
          rssSlope <= ceilings.ceilingRssGrowthBytesPerCycle &&
          descriptorGrowth <= ceilings.ceilingDescriptorGrowth);

      const drift = await rigDriftBudgetMs("scale", OWNER);
      const withinDrift = drift === null || latencyCreepFactor <= drift;
      const passed = invariantsHeld && growthHeld;

      console.log("\n========== LONG-RUN SOAK ==========");
      console.log(
        `duration:            ${SOAK_MINUTES} min requested, ${(totalMs / 60_000).toFixed(2)} min run`
      );
      console.log(
        `cycles:              ${samples.length} (${WARMUP_CYCLES} discarded as warm-up), ${totalOps} ops`
      );
      console.log(
        `cycle wall clock:    first third ${firstThird.toFixed(0)} ms → last third ` +
          `${lastThird.toFixed(0)} ms  (x${latencyCreepFactor.toFixed(2)})`
      );
      console.log(
        `RSS:                 ${(measured[0]?.rssBytes ?? 0) / 1024 / 1024} MiB → ` +
          `${(measured.at(-1)?.rssBytes ?? 0) / 1024 / 1024} MiB, slope ${Math.round(rssSlope)} B/cycle`
      );
      console.log(`heapUsed slope:      ${Math.round(heapSlope)} B/cycle`);
      console.log(
        `arrayBuffers slope:  ${Math.round(arrayBufferSlope)} B/cycle`
      );
      console.log(
        `gateway SQLite:      ${measured[0]?.dbBytes ?? 0} B → ${measured.at(-1)?.dbBytes ?? 0} B, ` +
          `slope ${Math.round(dbSlope)} B/cycle`
      );
      console.log(
        `open descriptors:    max ${maxDescriptors ?? "n/a"}, spread ${descriptorGrowth}`
      );
      console.log(`refusals:            ${JSON.stringify(refusals)}`);
      console.log(
        atDeclaredDuration
          ? `growth ceilings ASSERTED (>= ${ceilings.declaredSoakMinutes} min)`
          : `growth ceilings REPORTED ONLY — this run is ${SOAK_MINUTES} min, ` +
              `the ceilings are stated at ${ceilings.declaredSoakMinutes} min. ` +
              "Set CENTRAID_SOAK_MINUTES to gate them."
      );
      console.log("===================================\n");

      await recordQualityResult({
        lane: "scale",
        owner: OWNER,
        name: `Long-run soak: ${samples.length} household cycles over ${(totalMs / 60_000).toFixed(2)} min`,
        status: passed ? "passed" : "failed",
        measurements: [
          {
            name: "latency creep (last third / first third)",
            value: latencyCreepFactor,
            unit: "x",
            budget: ceilings.ceilingLatencyCreepFactor,
          },
          { name: "soak wall clock", value: totalMs, unit: "ms" },
          { name: "cycles", value: samples.length, unit: "count" },
          { name: "ops", value: totalOps, unit: "count" },
          {
            name: "RSS growth",
            value: rssSlope,
            unit: "bytes/cycle",
            budget: ceilings.ceilingRssGrowthBytesPerCycle,
          },
          { name: "heapUsed growth", value: heapSlope, unit: "bytes/cycle" },
          {
            name: "arrayBuffers growth",
            value: arrayBufferSlope,
            unit: "bytes/cycle",
          },
          {
            name: "gateway SQLite growth",
            value: dbSlope,
            unit: "bytes/cycle",
          },
          {
            name: "open descriptors (max)",
            value: maxDescriptors ?? 0,
            unit: "count",
            budget: ceilings.ceilingOpenDescriptors,
          },
          {
            name: "open descriptor spread",
            value: descriptorGrowth,
            unit: "count",
            budget: ceilings.ceilingDescriptorGrowth,
          },
        ],
      });

      expect(
        transportErrors,
        "a soaking gateway must never drop a connection"
      ).toStrictEqual([]);
      expect(
        untyped,
        `every refusal during the soak must be a typed product refusal; untyped: ${untyped.join(", ")}`
      ).toStrictEqual([]);
      expect(samples.length).toBeGreaterThanOrEqual(MIN_CYCLES);
      expect(
        maxDescriptors === null ||
          maxDescriptors <= ceilings.ceilingOpenDescriptors,
        `descriptor ceiling: peaked at ${maxDescriptors} open descriptors, ceiling ${ceilings.ceilingOpenDescriptors}`
      ).toBe(true);
      // Unconditional assertion on a boolean rather than a conditional expect:
      // the growth ceilings are stated AT declaredSoakMinutes, and
      // `growthHeld` already encodes that a shorter run reports without gating.
      expect(
        growthHeld,
        `soak growth ceilings (asserted only at >= ${ceilings.declaredSoakMinutes} min; this run was ${SOAK_MINUTES} min): ` +
          `latency creep x${latencyCreepFactor.toFixed(2)} vs x${ceilings.ceilingLatencyCreepFactor}, ` +
          `RSS ${Math.round(rssSlope)} B/cycle vs ${ceilings.ceilingRssGrowthBytesPerCycle}, ` +
          `descriptor spread ${descriptorGrowth} vs ${ceilings.ceilingDescriptorGrowth}`
      ).toBe(true);
      expect(
        withinDrift,
        `sustained drift: latency creep x${latencyCreepFactor} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
      ).toBe(true);
    },
    RUNAWAY_GUARD_MS
  );
});
