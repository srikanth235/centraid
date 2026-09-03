import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { IndexedDbIntentStore } from "../../packages/client/src/replica/intent-store.js";
import { IntentQueue } from "../../packages/client/src/replica/intents.js";
import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/replica-sync-io.perf.test.ts";
const BUDGET_MS = rigBudgetMs(OWNER);
const OVERLAY_BUDGET_MS = BUDGET_MS / 10;

describe("replica-sync-io.perf", () => {
  beforeEach(() => vi.stubGlobal("IDBKeyRange", IDBKeyRange));
  afterEach(() => vi.unstubAllGlobals());

  test("intent store open + 200 enqueue/list stays under IO budget", async () => {
    const factory = new IDBFactory();
    const name = `perf-replica-${crypto.randomUUID()}`;
    const started = performance.now();
    const store = await IndexedDbIntentStore.open(name, factory);
    const queue = new IntentQueue(store);
    const enqueueNext = async (i: number): Promise<void> => {
      if (i >= 200) return;
      await queue.enqueue({
        intentId: `intent-${i}`,
        appId: "agenda",
        action: "complete",
        input: { taskId: `t-${i}` },
        optimistic: [
          {
            op: "upsert",
            shapeId: "shape-agenda",
            entity: "core.task",
            rowId: `t-${i}`,
            values: { status: "done" },
          },
        ],
      });
      return enqueueNext(i + 1);
    };
    await enqueueNext(0);
    const listed = await queue.list();
    const overlayStarted = performance.now();
    const overlays = await queue.overlayMutations("shape-agenda", "core.task");
    const overlayMs = performance.now() - overlayStarted;
    const durationMs = performance.now() - started;
    store.close();
    const drift = await rigDriftBudgetMs("perf", OWNER);
    const passed =
      listed.length === 200 &&
      overlays.length === 200 &&
      durationMs < BUDGET_MS &&
      overlayMs < OVERLAY_BUDGET_MS;
    const withinDrift = drift === null || durationMs <= drift;
    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: "Replica intent IO (200 enqueues)",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
          budget: BUDGET_MS,
        },
        {
          name: "overlay enumeration and composition",
          value: overlayMs,
          unit: "ms",
          budget: OVERLAY_BUDGET_MS,
        },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(listed).toHaveLength(200);
    expect(overlays).toHaveLength(200);
    expect(overlayMs).toBeLessThan(OVERLAY_BUDGET_MS);
    expect(durationMs).toBeLessThan(BUDGET_MS);
  });
});
