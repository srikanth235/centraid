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

const OWNER = "tests/scale/long-run-soak.scale.test.ts";

const SOAK_MINUTES = (() => {
  const raw = Number(process.env.CENTRAID_SOAK_MINUTES ?? "0.75");
  return Number.isFinite(raw) && raw > 0 ? raw : 0.75;
})();

const MIN_CYCLES = 12;
const WARMUP_CYCLES = 3;
const OPS_PER_LANE = 3;
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

      const invariantsHeld =
        samples.length >= MIN_CYCLES &&
        transportErrors.length === 0 &&
        untyped.length === 0 &&
        (maxDescriptors === null ||
          maxDescriptors <= ceilings.ceilingOpenDescriptors);
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
