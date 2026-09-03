import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { NodeSqliteDriver } from "../../packages/client/src/replica/node-sqlite-test-driver.js";
import { ReplicaSqliteStore } from "../../packages/client/src/replica/store-core.js";
import type { ReplicaCursor } from "../../packages/client/src/replica/types.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";
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

const FULL_READ_CEILING_MS = 4000;
const FILTERED_READ_CEILING_MS = 1500;

const IN_READ_CEILING_MS = 1500;

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
      expect(bootstrapCursor).toStrictEqual({ epoch: "replica-1", seq: 1 });

      const full = time(() => store.read(READ_REQUESTS.fullEntity!));
      expect(full.value.rows).toHaveLength(ROW_COUNT);
      expect(full.value.coverage).toBe("complete");

      const filtered = time(() => store.read(READ_REQUESTS.filteredSorted!));
      const timeline = filtered.value.rows;
      expect(timeline).toHaveLength(200);
      for (const row of timeline) {
        expect(row.values.kind).toBe("photo");
        expect(row.values.deleted_at).toBeNull();
      }
      const capturedAt = timeline.map((row) => String(row.values.created_at));
      expect(capturedAt).toStrictEqual([...capturedAt].sort().toReversed());

      const inFilter = time(() => store.read(READ_REQUESTS.inFilter!));
      const matched = inFilter.value.rows;
      expect(matched).toHaveLength(IN_ID_COUNT);
      expect(new Set(matched.map((row) => row.rowId))).toStrictEqual(
        new Set(inFilterIds())
      );

      const slowestMs = Math.max(
        full.durationMs,
        filtered.durationMs,
        inFilter.durationMs
      );
      const drift = await rigDriftBudgetMs("scale", OWNER);
      const withinCeilings =
        full.durationMs < FULL_READ_CEILING_MS &&
        filtered.durationMs < FILTERED_READ_CEILING_MS &&
        inFilter.durationMs < IN_READ_CEILING_MS;
      const withinDrift = drift === null || slowestMs <= drift;

      await recordQualityResult({
        lane: "scale",
        owner: OWNER,
        name: "Replica query engine at 50k rows",
        status: withinCeilings && withinDrift ? "passed" : "failed",
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

      expect(
        withinDrift,
        `sustained drift: ${slowestMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
      ).toBe(true);
      expect(full.durationMs).toBeLessThan(FULL_READ_CEILING_MS);
      expect(filtered.durationMs).toBeLessThan(FILTERED_READ_CEILING_MS);
      expect(inFilter.durationMs).toBeLessThan(IN_READ_CEILING_MS);
    },
    IN_READ_TIMEOUT_MS
  );

  test("a 200-row page costs a fraction of a 50,000-row read — the limit is the plan", () => {
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
    expect(timestamps.size).toBeGreaterThan(rows.length * 0.9);
  });
});
