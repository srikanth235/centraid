import { describe, expect, test } from "vitest";

import { planContentEviction } from "./eviction";
import type { StoredContentEntry } from "./eviction";

function entry(
  key: string,
  bytes: number,
  lastUsedAt: number,
  pinned = false
): StoredContentEntry {
  return { key, bytes, lastUsedAt, pinned };
}

describe(planContentEviction, () => {
  test("an under-budget store evicts nothing", () => {
    const plan = planContentEviction(
      [entry("a", 10, 1), entry("b", 10, 2)],
      100
    );
    expect(plan.evict).toStrictEqual([]);
    expect(plan.keptBytes).toBe(20);
    expect(plan.overBudgetBy).toBe(0);
  });

  test("over budget, the oldest-used unpinned entries go first", () => {
    const plan = planContentEviction(
      [entry("new", 30, 300), entry("old", 30, 100), entry("mid", 30, 200)],
      60
    );
    expect(plan.evict).toStrictEqual(["old"]);
    expect(plan.keptBytes).toBe(60);
  });

  test("a pinned entry survives a pass that evicts every unpinned peer", () => {
    const plan = planContentEviction(
      [
        entry("kept", 50, 1, true),
        entry("peer-old", 40, 2),
        entry("peer-new", 40, 3),
      ],
      60
    );
    expect(plan.evict).toStrictEqual(["peer-old", "peer-new"]);
    expect(plan.evict).not.toContain("kept");
    expect(plan.pinnedBytes).toBe(50);
  });

  test("a pin older than every unpinned peer is still not a candidate", () => {
    const plan = planContentEviction(
      [entry("ancient-pin", 80, 1, true), entry("fresh", 40, 9_000)],
      100
    );
    expect(plan.evict).toStrictEqual(["fresh"]);
  });

  test("pins alone over budget leave the store over budget and say so", () => {
    const plan = planContentEviction(
      [
        entry("pin-a", 80, 1, true),
        entry("pin-b", 80, 2, true),
        entry("x", 10, 3),
      ],
      100
    );
    expect(plan.evict).toStrictEqual(["x"]);
    expect(plan.keptBytes).toBe(160);
    expect(plan.pinnedBytes).toBe(160);
    expect(plan.overBudgetBy).toBe(60);
  });

  test("the plan is deterministic when last-used stamps tie", () => {
    const first = planContentEviction(
      [entry("b", 40, 5), entry("a", 40, 5), entry("c", 40, 5)],
      80
    );
    const second = planContentEviction(
      [entry("c", 40, 5), entry("b", 40, 5), entry("a", 40, 5)],
      80
    );
    expect(first.evict).toStrictEqual(["a"]);
    expect(second.evict).toStrictEqual(first.evict);
  });
});
