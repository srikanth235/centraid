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

/**
 * COMPOSITE LOAD (issue #842 W4.1).
 *
 * Every perf and scale rig in this repo before this one measures a single
 * dimension against a quiet host: `gateway-sessions` fans 40 session probes at
 * an otherwise idle gateway, `blob-egress` streams 128 MiB at an otherwise idle
 * gateway, `replica-bootstrap` walks 50,000 rows at an otherwise idle gateway.
 * A household does none of those things alone. A phone uploads a burst of
 * photos WHILE a laptop catches up its replica WHILE someone searches WHILE an
 * automation fires WHILE an agent answers — and the interference between them
 * is exactly the cost that a per-dimension rig cannot see.
 *
 * This rig runs both halves in ONE process against ONE real `serve()` gateway
 * so the comparison is apples to apples:
 *
 *   1. SOLO — each lane alone, back to back. This is the per-dimension world
 *      the existing rigs measure, re-measured HERE on THIS machine so the
 *      composite number is compared against a baseline from the same host and
 *      the same run, not against a constant measured on someone's laptop.
 *   2. COMPOSITE — every lane at once, same op counts, plus the two in-process
 *      lanes (harness turn dispatch and the automation missed-window scan) so
 *      the CPU is contended the way a real gateway's is.
 *
 * The headline budget is therefore a RATIO, not a duration —
 * `compositeMs / soloMs` — because a ratio measured on the same host in the
 * same run is the only form of this budget that survives moving between a
 * developer laptop and a CI runner, and because it answers the actual product
 * question: does putting the household's activities together cost more than
 * doing them one after another? The second gate is an absolute ceiling on the
 * slowest lane under composition, which is the starvation check. See the
 * comment at `worstByFactor` below for why the obvious third candidate — a
 * per-lane p95 ratio — is published but deliberately NOT gated.
 *
 * Refusals are permitted and are NOT failures — a gateway that sheds load with
 * a typed refusal is behaving correctly (that is W4.2's subject). What fails
 * here is an UNTYPED refusal, a transport error, or a lane that did not finish
 * its ops.
 */
const OWNER = "tests/scale/composite-load.scale.test.ts";

/** Ops per HTTP lane, in each of the two phases. */
const OPS = 20;
/** In-flight requests per lane. Two: the household, not a load generator. */
const LANE_CONCURRENCY = 2;
/** Harness turn dispatches fanned during the composite phase. */
const TURNS = 128;
/** Automations whose missed windows are scanned during the composite phase. */
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

/**
 * The two lanes that are not HTTP. Both drive real product code: `runTurn` is
 * the shipped harness registry (with a scripted backend, as
 * `harness-sessions.scale.test.ts` does — a rig that spawned real model
 * adapters would measure a vendor's queue, not this product), and
 * `computeMissedWindows` is the shipped scheduler ledger scan.
 */
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
    // #883 C2 item 4. The worst-lane ceiling only ever fences whichever lane
    // happens to be slowest, so the READ lane the blob-reference CTE work
    // touches gets its own number rather than hiding behind the write lane's.
    const ceilingRefSearchP95Ms =
      ceilings.metrics.refSearchUnderComposition.ceilingP95Ms;
    const refSearch = () =>
      factors.find((entry) => entry.lane === "browse")?.compositeP95 ??
      Number.NaN;

    const gateway = await bootCompositeGateway("composite-load-");
    onTestFinished(() => gateway.close());

    // Phase 1 — SOLO. Sequential so no lane contends with another; this is
    // the per-dimension baseline the existing rigs represent, measured here.
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

    // Phase 2 — COMPOSITE. Every lane at once, plus the in-process lanes.
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
    // ── Choosing the budget shape ─────────────────────────────────────────
    //
    // The obvious budget — per-lane `compositeP95 / soloP95` — was measured
    // first and REJECTED as a gate, because the first run showed why it does
    // not work: the `browse` lane's solo p95 is ~5 ms, so its ratio under
    // composition is x49 while its absolute p95 is 234 ms. A ratio over a
    // near-zero denominator fences scheduler noise, not composition, and a
    // gate that flakes is a gate that gets widened. The per-lane factors are
    // still COMPUTED AND PUBLISHED below — they are the interesting finding —
    // they are simply not the thing that fails the build.
    //
    // What gates instead, and why each is the honest form of the question:
    //
    //   throughputFactor = compositeMs / soloMs — does putting the household's
    //   activities together cost MORE than doing them one after another? A
    //   gateway that overlaps work lands well below 1.0; a gateway that has
    //   serialized behind one lock lands at or above 1.0. Denominator is a
    //   whole phase, so it is stable.
    //
    //   worstLaneP95Ms — an ABSOLUTE ceiling on the slowest lane under
    //   composition. This is the starvation gate: it fires when any one lane
    //   is pushed past what an owner would tolerate, whatever its solo cost.
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
