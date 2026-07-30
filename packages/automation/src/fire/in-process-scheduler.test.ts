import { afterEach, describe, expect, it, vi } from "vitest";

import type { Row } from "../scaffold/app.js";
import { InProcessScheduler } from "./in-process-scheduler.js";
import { at, manifest, row, settle } from "./in-process-scheduler.test-kit.js";

describe("InProcessScheduler.reconcile", () => {
  it("diffs added / updated / removed and tracks only enabled cron rows", async () => {
    const s = new InProcessScheduler({ fire: () => {} });

    let diff = await s.reconcile([
      row("a/one", true, ["0 8 * * *"]),
      row("a/two", false, ["0 9 * * *"]), // disabled → skipped
      row("a/three", true, []), // no cron → skipped
    ]);
    expect(diff.added).toStrictEqual(["a/one"]);
    expect(diff.removed).toStrictEqual([]);
    await expect(s.list()).resolves.toStrictEqual(["a/one"]);

    // Change one's schedule, add one, drop the original.
    diff = await s.reconcile([
      row("a/one", true, ["30 8 * * *"]), // expr changed → updated
      row("b/four", true, ["0 10 * * *"]), // new → added
    ]);
    expect(diff.added).toStrictEqual(["b/four"]);
    expect(diff.updated).toStrictEqual(["a/one"]);
    expect(diff.removed).toStrictEqual([]);
    await expect(s.list()).resolves.toStrictEqual(["a/one", "b/four"]);
  });

  it("register/unregister honour enabled + cron presence", async () => {
    const s = new InProcessScheduler({ fire: () => {} });
    await s.register(row("a/one", true, ["0 8 * * *"]));
    await expect(s.list()).resolves.toStrictEqual(["a/one"]);
    // Disabling via register drops it from the registry.
    await s.register(row("a/one", false, ["0 8 * * *"]));
    await expect(s.list()).resolves.toStrictEqual([]);
    await s.register(row("a/one", true, ["0 8 * * *"]));
    await s.unregister("a/one");
    await expect(s.list()).resolves.toStrictEqual([]);
  });
});

describe("InProcessScheduler.tick", () => {
  it("fires each due cron once and catches the latest missed instant", async () => {
    const fired: string[] = [];
    let clock = at(8, 0);
    const s = new InProcessScheduler({
      fire: (ref) => void fired.push(ref),
      now: () => clock,
    });
    await s.reconcile([
      row("a/morning", true, ["0 8 * * *"]),
      row("a/evening", true, ["0 20 * * *"]),
    ]);
    // Registering at 08:00 does not run the 08:00 automation: cron has the
    // same no-fire bootstrap data triggers get.
    await settle();
    expect(fired).toStrictEqual([]);

    // 08:00 — only the morning automation matches.
    s.tick();
    await settle();
    expect(fired).toStrictEqual(["a/morning"]);

    // Same minute again — de-duped, no second fire.
    s.tick();
    await settle();
    expect(fired).toStrictEqual(["a/morning"]);

    // The scheduler slept across 20:00. Its cursor catches the latest due
    // instant on the first wake minute instead of losing the evening run.
    clock = at(20, 1);
    s.tick();
    await settle();
    expect(fired).toStrictEqual(["a/morning", "a/evening"]);
  });

  it("fires every registered automation whose cron matches the minute", async () => {
    const fired: string[] = [];
    const clock = at(8, 0);
    const s = new InProcessScheduler({
      fire: (ref) => void fired.push(ref),
      now: () => clock,
    });
    await s.reconcile([
      row("a/one", true, ["0 8 * * *"]),
      row("b/two", true, ["*/15 * * * *"]), // also matches :00
      row("c/three", true, ["0 9 * * *"]), // does not
    ]);
    s.tick();
    await settle();
    expect(fired.sort()).toStrictEqual(["a/one", "b/two"]);
  });
});

describe("condition-trigger watches", () => {
  function conditionRow(ref: string, every?: string): Row {
    const [ownerApp, id] = ref.split("/") as [string, string];
    const triggers = [
      { kind: "cron" as const, expr: "0 8 * * *" },
      {
        kind: "condition" as const,
        entity: "business.invoice",
        ...(every === undefined ? {} : { every }),
      },
    ];
    return {
      id,
      dir: `/tmp/${id}`,
      name: id,
      ownerApp,
      ref,
      enabled: true,
      triggers,
      manifest: { ...manifest(true), triggers },
    };
  }

  it("gates evaluation on the trigger every-cron with the ORIGINAL trigger index", async () => {
    const fires: string[] = [];
    const evals: Array<[string, number]> = [];
    let clock = at(8, 0);
    const s = new InProcessScheduler({
      fire: (ref) => void fires.push(ref),
      evaluate: (ref, idx) => void evals.push([ref, idx]),
      now: () => clock,
    });
    await s.register(conditionRow("studio/chaser", "*/10 * * * *"));

    // 08:00 — the cron fires AND the */10 gate opens; the condition trigger
    // sits at index 1 of manifest.triggers (after the cron).
    s.tick();
    expect(fires).toStrictEqual(["studio/chaser"]);
    expect(evals).toStrictEqual([["studio/chaser", 1]]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // 08:05 — neither.
    clock = at(8, 5);
    s.tick();
    expect(evals).toHaveLength(1);

    // 08:10 — gate only.
    clock = at(8, 10);
    s.tick();
    expect(fires).toHaveLength(1);
    expect(evals).toStrictEqual([
      ["studio/chaser", 1],
      ["studio/chaser", 1],
    ]);
  });

  it("a condition-only automation registers (no cron needed) and defaults to */5", async () => {
    const evals: number[] = [];
    let clock = at(9, 0);
    const s = new InProcessScheduler({
      fire: () => {},
      evaluate: (_ref, idx) => void evals.push(idx),
      now: () => clock,
    });
    const r = conditionRow("studio/chaser");
    // Strip the cron so only the condition trigger remains (index 0).
    const only: Row = { ...r, triggers: [r.triggers[1]!] };
    await s.register(only);
    await expect(s.list()).resolves.toStrictEqual(["studio/chaser"]);
    s.tick();
    expect(evals).toStrictEqual([0]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    clock = at(9, 3);
    s.tick();
    expect(evals).toStrictEqual([0]);
    clock = at(9, 5);
    s.tick();
    expect(evals).toStrictEqual([0, 0]);
  });

  it("without an evaluator, condition triggers never gate open", async () => {
    const s = new InProcessScheduler({ fire: () => {}, now: () => at(9, 0) });
    const r = conditionRow("studio/chaser", "* * * * *");
    await s.register({ ...r, triggers: [r.triggers[1]!] });
    expect(() => s.tick()).not.toThrow();
  });
});

describe("InProcessScheduler.nudge", () => {
  // Fake-timer tests call vi.useFakeTimers(); always restore so real-timer
  // suites (bootstrap / cron backstop) never inherit a stuck clock.
  afterEach(() => {
    vi.useRealTimers();
  });

  function dataRow(ref: string, entities: readonly string[]): Row {
    const [ownerApp, id] = ref.split("/") as [string, string];
    const triggers = [{ kind: "data" as const, entities }];
    return {
      id,
      dir: `/tmp/${id}`,
      name: id,
      ownerApp,
      ref,
      enabled: true,
      triggers,
      manifest: { ...manifest(true), triggers },
    };
  }

  it("coalesces a burst into one filtered data-trigger evaluation pass", async () => {
    vi.useFakeTimers();
    const evals: Array<[string, number]> = [];
    const s = new InProcessScheduler({
      fire: () => {},
      evaluate: (ref, index) => void evals.push([ref, index]),
      nudgeDelayMs: 25,
    });
    await s.reconcile([
      dataRow("studio/invoices", ["business.invoice"]),
      dataRow("studio/transactions", ["core.transaction"]),
    ]);
    evals.length = 0;

    // Model five committed write hints spread across a tight burst rather
    // than five calls in the same JS turn. The fixed window starts at the
    // first hint and all later hints inside it join the same pass.
    s.nudge(["business.invoice"]);
    await vi.advanceTimersByTimeAsync(5);
    s.nudge(["business.invoice"]);
    await vi.advanceTimersByTimeAsync(5);
    s.nudge(["business.invoice"]);
    s.nudge(["business.invoice"]);
    s.nudge(["business.invoice"]);
    expect(evals).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(15);

    expect(evals).toStrictEqual([["studio/invoices", 0]]);
  });

  it("bypasses the minute gate while leaving condition triggers poll-only", async () => {
    vi.useFakeTimers();
    const evals: Array<[string, number]> = [];
    const s = new InProcessScheduler({
      fire: () => {},
      evaluate: (ref, index) => void evals.push([ref, index]),
      now: () => at(9, 0),
      nudgeDelayMs: 0,
    });
    const condition = {
      ...dataRow("studio/condition", ["business.invoice"]),
      triggers: [{ kind: "condition" as const, entity: "business.invoice" }],
    };
    await s.reconcile([
      dataRow("studio/data", ["business.invoice"]),
      condition,
    ]);
    evals.length = 0;

    s.tick();
    expect(evals).toStrictEqual([
      ["studio/data", 0],
      ["studio/condition", 0],
    ]);
    s.nudge(["business.invoice"]);
    // nudgeDelayMs: 0 still schedules via setTimeout — advance the fake clock.
    await vi.advanceTimersByTimeAsync(0);

    expect(evals).toStrictEqual([
      ["studio/data", 0],
      ["studio/condition", 0],
      ["studio/data", 0],
    ]);
  });

  it("bootstraps a fresh data watcher during reconcile before its first write", async () => {
    vi.useFakeTimers();
    const evals: Array<[string, number]> = [];
    const s = new InProcessScheduler({
      fire: () => {},
      evaluate: (ref, index) => void evals.push([ref, index]),
      nudgeDelayMs: 0,
    });
    await s.reconcile([dataRow("studio/data", ["core.party"])]);
    expect(evals).toStrictEqual([["studio/data", 0]]);

    s.nudge(["core.party"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(evals).toStrictEqual([
      ["studio/data", 0],
      ["studio/data", 0],
    ]);
  });

  it("fails readiness on bootstrap error, restores the old registry, and retries", async () => {
    let fail = true;
    let evals = 0;
    const s = new InProcessScheduler({
      fire: () => {},
      evaluate: async () => {
        evals++;
        if (fail) throw new Error("cursor unavailable");
      },
    });

    await expect(
      s.reconcile([dataRow("studio/data", ["core.party"])])
    ).rejects.toThrow("cursor unavailable");
    await expect(s.list()).resolves.toStrictEqual([]);

    fail = false;
    await expect(
      s.reconcile([dataRow("studio/data", ["core.party"])])
    ).resolves.toMatchObject({
      added: ["studio/data"],
    });
    expect(evals).toBe(2);
    await expect(s.list()).resolves.toStrictEqual(["studio/data"]);
  });

  it("serializes a doorbell that races the minute tick and performs one dirty rerun", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const s = new InProcessScheduler({
      fire: () => {},
      now: () => at(9, 0),
      nudgeDelayMs: 0,
      evaluate: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) await gate;
        active--;
      },
    });
    await s.register(dataRow("studio/data", ["core.party"]));

    s.nudge(["core.party"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    s.tick();
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("the minute cron backstop consumes one missed offline change exactly once", async () => {
    let clock = at(9, 0);
    const journal = ["prov-1"];
    let cursor = "prov-1";
    let fires = 0;
    const s = new InProcessScheduler({
      fire: () => {},
      now: () => clock,
      evaluate: async () => {
        const cursorIndex = journal.indexOf(cursor);
        const changes = journal.slice(cursorIndex + 1);
        if (changes.length === 0) return;
        cursor = changes.at(-1)!;
        fires++;
      },
    });
    // register(), unlike reconcile(), models a restarted scheduler whose
    // persisted data cursor already exists. The write lands while no live
    // doorbell is present — the exact crash window the poll must cover.
    await s.register(dataRow("studio/data", ["core.party"]));
    journal.push("prov-2");

    s.tick();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect({ cursor, fires }).toStrictEqual({ cursor: "prov-2", fires: 1 });

    clock = at(9, 1);
    s.tick();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect({ cursor, fires }).toStrictEqual({ cursor: "prov-2", fires: 1 });
  });

  it("routes rejected off-cycle evaluations without rejecting the caller", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const s = new InProcessScheduler({
      fire: () => {},
      evaluate: async () => {
        throw new Error("nudge failed");
      },
      nudgeDelayMs: 0,
      onError: (error) =>
        errors.push(error instanceof Error ? error.message : String(error)),
    });
    await s.register(dataRow("studio/data", ["core.transaction"]));

    expect(() => s.nudge()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toStrictEqual(["nudge failed"]);
  });
});

describe("InProcessScheduler onTick hook (issue #351)", () => {
  it("fires once per processed minute, before any automation fire", async () => {
    const order: string[] = [];
    let clock = at(8, 0);
    const s = new InProcessScheduler({
      fire: (ref) => void order.push(`fire:${ref}`),
      onTick: (t) => void order.push(`tick:${t.getHours()}:${t.getMinutes()}`),
      now: () => clock,
    });
    await s.reconcile([row("a/one", true, ["0 8 * * *"])]);

    s.tick();
    await settle();
    expect(order).toStrictEqual(["tick:8:0", "fire:a/one"]);

    // Same minute again — de-duped, no second tick or fire.
    s.tick();
    await settle();
    expect(order).toStrictEqual(["tick:8:0", "fire:a/one"]);

    clock = at(8, 1);
    s.tick();
    await settle();
    expect(order).toStrictEqual(["tick:8:0", "fire:a/one", "tick:8:1"]);
  });

  it("a throwing onTick routes to onError instead of crashing the timer loop", async () => {
    const errors: Array<{ err: unknown; ref: string }> = [];
    const s = new InProcessScheduler({
      fire: () => {},
      onTick: () => {
        throw new Error("boom");
      },
      onError: (err, ref) => errors.push({ err, ref }),
      now: () => at(8, 0),
    });
    await s.reconcile([row("a/one", true, ["0 8 * * *"])]);
    expect(() => s.tick()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.err).toBeInstanceOf(Error);
  });

  it("does not persist a scheduler tick when no automations are enabled (#456 I3)", () => {
    let ticks = 0;
    const s = new InProcessScheduler({
      fire: () => {},
      onTick: () => {
        ticks += 1;
      },
      now: () => at(8, 0),
    });
    s.tick();
    expect(ticks).toBe(0);
  });

  it("reports only active/dormant transitions so the host can reset liveness once", async () => {
    const transitions: boolean[] = [];
    const s = new InProcessScheduler({
      fire: () => {},
      onDormancyChange: (dormant) => void transitions.push(dormant),
      now: () => at(8, 0),
    });
    await s.reconcile([]);
    await s.reconcile([row("a/one", true, ["0 8 * * *"])]);
    await s.reconcile([row("a/one", true, ["0 8 * * *"])]);
    await s.reconcile([]);
    expect(transitions).toStrictEqual([false, true]);
  });

  it("onTick is optional — omitting it changes nothing about firing", async () => {
    const fired: string[] = [];
    const s = new InProcessScheduler({
      fire: (ref) => void fired.push(ref),
      now: () => at(8, 0),
    });
    await s.reconcile([row("a/one", true, ["0 8 * * *"])]);
    expect(() => s.tick()).not.toThrow();
    expect(fired).toStrictEqual(["a/one"]);
  });
});
