import { readFile } from "node:fs/promises";

import { describe, expect, onTestFinished, test } from "vitest";

import { HARNESSES, runTurn } from "@centraid/server/acp";
import type { TurnConfig, TurnInput } from "@centraid/server/acp";
import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { forEachSequentially } from "@centraid/test-kit/sequential";

import { computeMissedWindows } from "../../packages/server/src/automation/fire/scheduler-ledger.js";
import {
  blobLane,
  bootCompositeGateway,
  browseLane,
  mergeLanes,
  percentile,
  searchLane,
  syncLane,
  writeLane,
} from "../helpers/composite-workload.js";
import type {
  CompositeGateway,
  LaneResult,
} from "../helpers/composite-workload.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/composite-load.scale.test.ts";

const OPS = 20;
const LANE_CONCURRENCY = 2;
const TURNS = 128;
const AUTOMATIONS = 200;

interface CeilingFile {
  metrics: {
    compositeLoadFactor: {
      ceilingThroughputFactor: number;
      ceilingWorstLaneP95Ms: number;
    };
    refSearchUnderComposition: { ceilingP95Ms: number };
  };
}

async function httpLanes(
  gateway: CompositeGateway,
  seed: number
): Promise<LaneResult[]> {
  return Promise.all([
    syncLane(gateway, OPS, LANE_CONCURRENCY),
    searchLane(gateway, OPS, seed + 1, LANE_CONCURRENCY),
    writeLane(gateway, OPS, seed + 2, LANE_CONCURRENCY),
    blobLane(gateway, OPS, seed + 3, 64 * 1024, LANE_CONCURRENCY),
    browseLane(gateway, OPS, seed + 4, LANE_CONCURRENCY),
  ]);
}

async function inProcessLanes(): Promise<{
  turnsMs: number;
  automationsMs: number;
  turnIds: number;
  missed: number;
}> {
  const original = HARNESSES.acp;
  HARNESSES.acp = {
    ...original,
    runTurn: async (input) => ({
      harnessKind: "acp",
      sessionId: String(input.message),
    }),
  };
  try {
    const config: TurnConfig = {
      prefs: { kind: "acp", binPath: "/bin/unused" },
    };
    const turnsStarted = performance.now();
    const results = await Promise.all(
      Array.from({ length: TURNS }, (_, index) =>
        runTurn(
          {
            cwd: process.cwd(),
            message: `composite-${index}`,
            extraSystemPrompt: "",
            abortSignal: new AbortController().signal,
            onEvent: () => undefined,
          } as unknown as TurnInput,
          config
        )
      )
    );
    const turnsMs = performance.now() - turnsStarted;

    const automationsStarted = performance.now();
    const missed = computeMissedWindows({
      lastTickAt: new Date("2026-01-01T00:00:00.000Z"),
      now: new Date("2026-01-01T06:00:00.000Z"),
      entries: Array.from({ length: AUTOMATIONS }, (_, index) => ({
        ref: `composite-auto-${index}`,
        crons: ["*/15 * * * *"] as const,
      })),
    });
    return {
      turnsMs,
      automationsMs: performance.now() - automationsStarted,
      turnIds: new Set(results.map((result) => result.sessionId)).size,
      missed: missed.length,
    };
  } finally {
    HARNESSES.acp = original;
  }
}

describe("composite-load.scale", () => {
  test("sync + search + writes + blob ingest + turns + automations hold their budgets when run together", async () => {
    const ceilings = JSON.parse(
      await readFile("tests/experience-budgets/gateway.json", "utf8")
    ) as CeilingFile;
    const ceilingThroughputFactor =
      ceilings.metrics.compositeLoadFactor.ceilingThroughputFactor;
    const ceilingWorstLaneP95Ms =
      ceilings.metrics.compositeLoadFactor.ceilingWorstLaneP95Ms;
    const ceilingRefSearchP95Ms =
      ceilings.metrics.refSearchUnderComposition.ceilingP95Ms;
    const refSearch = () =>
      factors.find((entry) => entry.lane === "browse")?.compositeP95 ??
      Number.NaN;

    const gateway = await bootCompositeGateway("composite-load-");
    onTestFinished(() => gateway.close());

    const soloStarted = performance.now();
    const solo: LaneResult[] = [];
    await forEachSequentially(
      [
        () => syncLane(gateway, OPS, LANE_CONCURRENCY),
        () => searchLane(gateway, OPS, 101, LANE_CONCURRENCY),
        () => writeLane(gateway, OPS, 102, LANE_CONCURRENCY),
        () => blobLane(gateway, OPS, 103, 64 * 1024, LANE_CONCURRENCY),
        () => browseLane(gateway, OPS, 104, LANE_CONCURRENCY),
      ],
      async (lane) => {
        solo.push(await lane());
      }
    );
    const soloMs = performance.now() - soloStarted;

    const compositeStarted = performance.now();
    const [composite, inProcess] = await Promise.all([
      httpLanes(gateway, 201),
      inProcessLanes(),
    ]);
    const compositeMs = performance.now() - compositeStarted;

    const soloByLane = new Map(solo.map((lane) => [lane.lane, lane]));
    const factors = composite.map((lane) => {
      const baseline = soloByLane.get(lane.lane)!;
      const soloP95 = percentile(baseline.latencyMs, 0.95);
      const compositeP95 = percentile(lane.latencyMs, 0.95);
      return {
        lane: lane.lane,
        soloP95,
        compositeP95,
        factor: soloP95 > 0 ? compositeP95 / soloP95 : Number.NaN,
      };
    });
    const worstByFactor = factors.reduce((left, right) =>
      right.factor > left.factor ? right : left
    );
    const worstByP95 = factors.reduce((left, right) =>
      right.compositeP95 > left.compositeP95 ? right : left
    );
    const throughputFactor = soloMs > 0 ? compositeMs / soloMs : Number.NaN;

    const soloTally = mergeLanes(solo);
    const compositeTally = mergeLanes(composite);
    const untyped = Object.keys({
      ...soloTally.refusals,
      ...compositeTally.refusals,
    }).filter((key) => key.endsWith("/untyped"));

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const withinDrift = drift === null || compositeMs <= drift;
    const everyLaneFinished =
      composite.every((lane) => lane.ops === OPS) &&
      solo.every((lane) => lane.ops === OPS);
    const passed =
      everyLaneFinished &&
      soloTally.transportErrors.length === 0 &&
      compositeTally.transportErrors.length === 0 &&
      untyped.length === 0 &&
      inProcess.turnIds === TURNS &&
      inProcess.missed === AUTOMATIONS &&
      throughputFactor <= ceilingThroughputFactor &&
      worstByP95.compositeP95 <= ceilingWorstLaneP95Ms &&
      refSearch() <= ceilingRefSearchP95Ms &&
      withinDrift;

    console.log("\n========== COMPOSITE LOAD ==========");
    console.log(`solo phase:        ${Math.round(soloMs)} ms`);
    console.log(
      `composite phase:   ${Math.round(compositeMs)} ms  (throughput factor x${throughputFactor.toFixed(2)})`
    );
    for (const entry of factors)
      console.log(
        `${entry.lane.padEnd(7)} p95 solo ${entry.soloP95.toFixed(1)} ms → composite ` +
          `${entry.compositeP95.toFixed(1)} ms  (x${entry.factor.toFixed(2)})`
      );
    console.log(
      `turn dispatch:     ${Math.round(inProcess.turnsMs)} ms for ${TURNS}`
    );
    console.log(
      `missed-window:     ${Math.round(inProcess.automationsMs)} ms for ${AUTOMATIONS}`
    );
    console.log(
      `refusals solo:     ${JSON.stringify(soloTally.refusals)}\n` +
        `refusals composite: ${JSON.stringify(compositeTally.refusals)}`
    );
    console.log("====================================\n");

    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name:
        `Composite load: ${OPS} ops x 5 HTTP lanes + ${TURNS} turns + ` +
        `${AUTOMATIONS} automations, solo vs together`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "composite phase wall clock",
          value: compositeMs,
          unit: "ms",
          ...(drift === null ? {} : { budget: drift }),
        },
        { name: "solo phase wall clock", value: soloMs, unit: "ms" },
        {
          name: "composition throughput factor (composite/solo)",
          value: throughputFactor,
          unit: "x",
          budget: ceilingThroughputFactor,
        },
        {
          name: `worst lane p95 under composition (${worstByP95.lane})`,
          value: worstByP95.compositeP95,
          unit: "ms",
          budget: ceilingWorstLaneP95Ms,
        },
        {
          name: "ref-search p95 under composition",
          value: refSearch(),
          unit: "ms",
          budget: ceilingRefSearchP95Ms,
        },
        {
          name: `worst per-lane latency factor (${worstByFactor.lane}, reported not gated)`,
          value: worstByFactor.factor,
          unit: "x",
        },
        ...factors.map((entry) => ({
          name: `${entry.lane} p95 composite`,
          value: entry.compositeP95,
          unit: "ms",
        })),
        ...factors.map((entry) => ({
          name: `${entry.lane} p95 solo`,
          value: entry.soloP95,
          unit: "ms",
        })),
        { name: "turn dispatch", value: inProcess.turnsMs, unit: "ms" },
        {
          name: "missed-window scan",
          value: inProcess.automationsMs,
          unit: "ms",
        },
        {
          name: "composite ops",
          value: compositeTally.ops,
          unit: "count",
        },
      ],
    });

    expect(
      refSearch(),
      `ref-search p95 under composition: ${refSearch()} ms vs ceiling ${ceilingRefSearchP95Ms} ms`
    ).toBeLessThanOrEqual(ceilingRefSearchP95Ms);
    expect(compositeTally.transportErrors).toStrictEqual([]);
    expect(soloTally.transportErrors).toStrictEqual([]);
    expect(
      untyped,
      `every refusal under composition must be a typed product refusal; untyped: ${untyped.join(", ")}`
    ).toStrictEqual([]);
    expect(everyLaneFinished).toBe(true);
    expect(inProcess.turnIds).toBe(TURNS);
    expect(inProcess.missed).toBe(AUTOMATIONS);
    expect(
      throughputFactor,
      `composition cost: the whole household together took ${Math.round(compositeMs)} ms ` +
        `against ${Math.round(soloMs)} ms one-lane-at-a-time (x${throughputFactor.toFixed(2)}), ` +
        `ceiling x${ceilingThroughputFactor}. Above 1.0 means running the lanes together is ` +
        `WORSE than serializing them — the gateway has stopped overlapping work.`
    ).toBeLessThanOrEqual(ceilingThroughputFactor);
    expect(
      worstByP95.compositeP95,
      `lane starvation: ${worstByP95.lane} p95 reached ${worstByP95.compositeP95.toFixed(1)} ms ` +
        `under composition (solo ${worstByP95.soloP95.toFixed(1)} ms), ceiling ${ceilingWorstLaneP95Ms} ms`
    ).toBeLessThanOrEqual(ceilingWorstLaneP95Ms);
    expect(
      withinDrift,
      `sustained drift: ${compositeMs} ms vs drift budget ${drift} ms (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
  }, 180_000);
});
