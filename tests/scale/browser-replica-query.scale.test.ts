/**
 * BROWSER-REPLICA QUERY ENGINE AT YEAR-3 VOLUME (#883 C1, re-baselined by C3).
 *
 * WHAT THIS MEASURES. `tests/scale/replica-bootstrap.scale.test.ts` proves the
 * client CONVERGES at 50,000 rows. This rig measures what the client then costs
 * to READ: a full-entity materialisation, a filtered + sorted 200-row page, and
 * an `in` over 1,000 ids — the album/selection fan-out.
 *
 * THE ENGINE UNDER TEST IS THE SHIPPING ONE. `SqliteReplicaStore` (web) is
 * `ReplicaSqliteStore` over a sqlite-wasm driver; the native store is the same
 * core over op-sqlite. This rig drives that same core over `node:sqlite` — the
 * driver seam the store's own conformance suites already use — so the read path
 * measured here is byte-for-byte the one the browser runs. Only the SQLite
 * binding differs, and the binding is not what this rig is about.
 *
 * WHAT C1 FOUND, AND WHAT C3 DID ABOUT IT. Until #883 C3 every read ran one
 * unfiltered `SELECT ... WHERE shape_id = ? AND entity = ?` that materialised
 * the WHOLE entity, a `JSON.parse` per row, and then `evaluateReplicaRead()` —
 * filter, sort and limit in JavaScript, with SQLite seeing no predicate at all.
 * An app asking for 200 timeline items parsed 50,000 payloads to throw 49,800
 * away, and the `in` read spent TWO MINUTES on a membership test a `Set`
 * answers in 16 ms. `packages/client/src/replica/read-plan.ts` compiles the
 * whole grammar — filters, order, limit and the refusals — into one statement,
 * and only the returned page is parsed. Measured on the 2026-08-28 development
 * container, before -> after:
 *
 *     full-entity read       272-361 ms  ->  179-255 ms
 *     filtered + sorted      610-632 ms  ->  109-112 ms      5.5x
 *     `in` over 1,000 ids  122,300 ms +  ->   64-70 ms   ~1,900x
 *
 * The full-entity read barely moves and should not: it genuinely returns 50,000
 * rows, so 50,000 `JSON.parse` calls are the irreducible floor. That is the
 * point — the cost is now proportional to the ANSWER rather than to the table.
 *
 * IT IS STILL THE PARITY ORACLE HARNESS. The corpus and the read requests live
 * in `browser-replica-query.fixture.ts` so both engines can be run against the
 * identical input; `packages/client/src/replica/read-plan-parity.test.ts` does
 * exactly that on the PR lane, row for row and refusal for refusal.
 *
 * ASSERTIONS ARE CATASTROPHE BOUNDS ONLY. Volumes this size on a shared CI
 * runner have a wide spread, and a tight ceiling here would fence the runner
 * rather than the product. The 30-sample/1.5x drift gate is the real gate; the
 * ceilings below only catch a collapse. The SHAPE assertions (row counts,
 * ordering, id set) are exact, and they are what makes the timings meaningful:
 * a read that returned nothing would be fast and wrong.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { NodeSqliteDriver } from "../../packages/client/src/replica/node-sqlite-test-driver.js";
import { ReplicaSqliteStore } from "../../packages/client/src/replica/store-core.js";
import type { ReplicaCursor } from "../../packages/client/src/replica/types.js";
import {
  buildCorpus,
  buildSnapshot,
  ENTITY,
  IN_ID_COUNT,
  inFilterIds,
  READ_REQUESTS,
  ROW_COUNT,
  SHAPE_ID,
} from "./browser-replica-query.fixture.js";

const OWNER = "tests/scale/browser-replica-query.scale.test.ts";

/**
 * Catastrophe bounds, not observed-plus-headroom, and TIGHTENED to the
 * post-pushdown reality (#883 C3 re-baseline; was 20,000 / 10,000 / 400,000).
 *
 * All three reads are now the SAME SHAPE of work — one statement, one page
 * parsed — so they no longer differ by three orders of magnitude and no longer
 * need ceilings that do. What separates them is how many rows the answer
 * carries: the full-entity read hands back all 50,000 and pays 50,000
 * `JSON.parse` calls for them, which is why it keeps the loosest bound.
 *
 * The headroom is ~15-20x the worst 2026-08-28 observation rather than the
 * ~2.5-3.5x a steady-state budget would take, and deliberately so: these are
 * now SUB-SECOND measurements, which is exactly the regime where a contended
 * shared runner's spread is largest in relative terms, and this file's own
 * doctrine is that a ceiling tight enough to fence the runner is worse than no
 * ceiling. Precision at that scale is the 30-sample/1.5x drift gate's job.
 * Tighten-only: these may fall again, never rise.
 */
const FULL_READ_CEILING_MS = 4000;
const FILTERED_READ_CEILING_MS = 1500;

/**
 * THE DEBT MARKER IS PAID (#883 C3). This ceiling was 400,000 ms, sized around
 * a read that measured **122,300 ms and 159,810 ms** — two to two-and-a-half
 * MINUTES for one album-sized fan-out, because `matches()` answered `in` with
 * `clause.value.some((candidate) => compare(rowValue, ...) === 0)`: O(rows x
 * ids), 49.5 million `compare()` calls, each allocating two `Uint8Array`s
 * through `TextEncoder.encode`. Roughly 99 million throwaway typed arrays for a
 * membership test a `Set` answers in 16 ms.
 *
 * The clause is now `json_extract(...) IN (SELECT value FROM json_each(?))` —
 * one bound JSON array, one scan, no JavaScript in the loop — and the read
 * measures **64-70 ms**: a ~1,900x collapse, and 267x tighter here. It is no
 * longer the outlier of the three, so it takes the same ceiling as the filtered
 * page, whose work it now resembles.
 *
 * NIGHTLY COST NOTE: this read alone used to be 2-3 minutes of every nightly
 * scale run. The whole file now finishes in about six seconds.
 */
const IN_READ_CEILING_MS = 1500;

/** Room for a collapsed `in` read to FAIL its ceiling instead of timing out. */
const IN_READ_TIMEOUT_MS = 120_000;

let store: ReplicaSqliteStore;
let bootstrapMs = 0;
let bootstrapCursor: ReplicaCursor | undefined;

function time<T>(work: () => T): { value: T; durationMs: number } {
  const started = performance.now();
  const value = work();
  return { value, durationMs: performance.now() - started };
}

describe("browser-replica-query.scale", () => {
  beforeAll(() => {
    // Built once for the whole file: the corpus and the bootstrap are inputs to
    // every measurement below, not part of any of them. The hook only RECORDS
    // what it saw; the assertion lives in a test, where a failure is reported
    // against a named claim rather than as a suite-wide setup error.
    store = new ReplicaSqliteStore(new NodeSqliteDriver(), "vault-scale");
    const started = performance.now();
    bootstrapCursor = store.bootstrap(buildSnapshot(buildCorpus()));
    bootstrapMs = performance.now() - started;
  }, 120_000);

  afterAll(() => {
    store.close();
  });

  test(
    "the replica query engine answers year-3 reads without collapsing",
    async () => {
      // The corpus really landed at the cursor the snapshot declared.
      expect(bootstrapCursor).toStrictEqual({ epoch: "replica-1", seq: 1 });

      // ── 1. Full-entity read: what a cold app mount pays ────────────────
      const full = time(() => store.read(READ_REQUESTS.fullEntity!));
      expect(full.value.rows).toHaveLength(ROW_COUNT);
      expect(full.value.coverage).toBe("complete");

      // ── 2. Filtered + sorted: the Photos timeline's first screen ───────
      const filtered = time(() => store.read(READ_REQUESTS.filteredSorted!));
      const timeline = filtered.value.rows;
      // The limit is 200 and the corpus holds far more live photos than that,
      // so a short page would mean the filter dropped rows it should have kept.
      expect(timeline).toHaveLength(200);
      for (const row of timeline) {
        expect(row.values.kind).toBe("photo");
        expect(row.values.deleted_at).toBeNull();
      }
      // Descending by created_at, exactly — the sort is half of what pushdown
      // must reproduce, so the oracle checks ORDER and not just membership.
      const capturedAt = timeline.map((row) => String(row.values.created_at));
      expect(capturedAt).toStrictEqual([...capturedAt].sort().toReversed());

      // ── 3. `in` over 1,000 ids × 50,000 rows: the O(rows × ids) hot spot ─
      const inFilter = time(() => store.read(READ_REQUESTS.inFilter!));
      const matched = inFilter.value.rows;
      expect(matched).toHaveLength(IN_ID_COUNT);
      expect(new Set(matched.map((row) => row.rowId))).toStrictEqual(
        new Set(inFilterIds())
      );

      const withinCeilings =
        full.durationMs < FULL_READ_CEILING_MS &&
        filtered.durationMs < FILTERED_READ_CEILING_MS &&
        inFilter.durationMs < IN_READ_CEILING_MS;

      await recordQualityResult({
        lane: "scale",
        owner: OWNER,
        name: "Replica query engine at 50k rows",
        status: withinCeilings ? "passed" : "failed",
        measurements: [
          {
            name: "full-entity read",
            value: full.durationMs,
            unit: "ms",
            budget: FULL_READ_CEILING_MS,
          },
          {
            name: "filtered + sorted read",
            value: filtered.durationMs,
            unit: "ms",
            budget: FILTERED_READ_CEILING_MS,
          },
          {
            name: `in over ${IN_ID_COUNT} ids`,
            value: inFilter.durationMs,
            unit: "ms",
            budget: IN_READ_CEILING_MS,
          },
          { name: "bootstrap", value: bootstrapMs, unit: "ms" },
          { name: "rows scanned per read", value: ROW_COUNT, unit: "rows" },
        ],
      });

      console.log(
        "\n========== REPLICA QUERY ENGINE @ 50k ROWS ==========\n" +
          `bootstrap:              ${bootstrapMs.toFixed(1)} ms\n` +
          `full-entity read:       ${full.durationMs.toFixed(1)} ms (${ROW_COUNT} rows out)\n` +
          `filtered + sorted read: ${filtered.durationMs.toFixed(1)} ms (200 rows out)\n` +
          `in over ${IN_ID_COUNT} ids:      ${inFilter.durationMs.toFixed(1)} ms (${IN_ID_COUNT} rows out)\n` +
          "  ^ #883 C3 pushdown is the shrinker for this one\n" +
          "====================================================\n"
      );

      expect(full.durationMs).toBeLessThan(FULL_READ_CEILING_MS);
      expect(filtered.durationMs).toBeLessThan(FILTERED_READ_CEILING_MS);
      expect(inFilter.durationMs).toBeLessThan(IN_READ_CEILING_MS);
    },
    IN_READ_TIMEOUT_MS
  );

  /**
   * THE CLAIM THIS FILE WAS BUILT TO FALSIFY, NOW FALSE.
   *
   * Until #883 C3 a read asking for 200 rows out of 50,000 cost what a read
   * asking for all of them cost — ratio 1.02x — because both scanned and parsed
   * the whole entity before the limit was applied. This test used to assert
   * that ratio stayed under 4x and carried the note "this is the regression
   * #883 C3 is meant to make FALSE — when it does, this test is the one to
   * rewrite". It did, so this is the rewrite: the same two reads, the same
   * printed ratio, and the inequality turned around.
   *
   * 151x and 177x on the two 2026-08-28 runs. The bound below is 10x, because
   * the claim is about ORDERS of magnitude and about the SHAPE of the plan: a
   * limit that buys nothing means the scan is back.
   */
  test("a 200-row page costs a fraction of a 50,000-row read — the limit is the plan", () => {
    // Warm: the first read of the file pays one-time schema/catalog lookups
    // that would otherwise be charged to whichever read ran first.
    store.read({ shapeId: SHAPE_ID, entity: ENTITY, limit: 1 });

    const tiny = time(
      () => store.read({ shapeId: SHAPE_ID, entity: ENTITY, limit: 200 }).rows
    );
    const whole = time(
      () =>
        store.read({ shapeId: SHAPE_ID, entity: ENTITY, limit: 100_000 }).rows
    );
    expect(tiny.value).toHaveLength(200);
    expect(whole.value).toHaveLength(ROW_COUNT);
    const ratio = whole.durationMs / Math.max(tiny.durationMs, 0.001);
    console.log(
      `limit=200 ${tiny.durationMs.toFixed(1)} ms vs limit=50000 ` +
        `${whole.durationMs.toFixed(1)} ms — ratio ${ratio.toFixed(2)}x ` +
        "(1.0x would mean the limit buys nothing and the scan is back)"
    );
    expect(
      ratio,
      "asking for 200 of 50,000 rows must not cost what asking for all of them costs"
    ).toBeGreaterThan(10);
  });

  /**
   * Anti-vacuity on the corpus itself: a fixture that built 50,000 identical
   * rows would make every filter above trivially satisfiable and the parity
   * oracle worthless.
   */
  test("the corpus is varied enough for the filters to mean something", () => {
    const rows = buildCorpus();
    const kinds = new Set(rows.map((row) => String(row.values.kind)));
    const deleted = rows.filter((row) => row.values.deleted_at !== null).length;
    const timestamps = new Set(
      rows.map((row) => String(row.values.created_at))
    );
    expect(kinds.size).toBeGreaterThan(1);
    expect(deleted).toBeGreaterThan(0);
    expect(deleted).toBeLessThan(rows.length);
    // Near-unique capture times: an ORDER BY over a column with mass ties
    // would exercise the tie-break instead of the sort.
    expect(timestamps.size).toBeGreaterThan(rows.length * 0.9);
  });
});
