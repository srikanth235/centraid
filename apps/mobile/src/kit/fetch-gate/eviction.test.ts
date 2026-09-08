import { describe, expect, test } from "vitest";

import { planContentEviction } from "./eviction";
import type { StoredContentEntry } from "./eviction";

function entry(
  key: string,
  bytes: number,
  lastUsedAt: number,
  pinned = false,
  extra: Partial<StoredContentEntry> = {}
): StoredContentEntry {
  return { key, bytes, lastUsedAt, pinned, kind: "original", ...extra };
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

  // THE LAW: a pinned item survives an eviction pass that removes its unpinned
  // peers. This is the demonstrated-red for "eviction respects pins" — flip
  // `pinned` to false on `kept` and the assertion below fails.
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
    // Reported, never resolved by breaking the promise.
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

// #996 R7/R25: two more things the LRU may not touch, and both are promises
// this seat has already made rather than preferences it holds.
describe("what the phone's byte policy protects beyond a pin", () => {
  test("a capture this phone made is not a candidate", () => {
    // It may be the only copy anywhere until the gateway verifies it.
    const plan = planContentEviction(
      [
        entry("kept", 100, 1, false, { capturedHere: true }),
        entry("old", 100, 2),
      ],
      100
    );
    expect(plan.evict).toStrictEqual(["old"]);
    expect(plan.pinnedBytes).toBe(100);
  });

  test("bytes a queued intent needs are not a candidate", () => {
    // The gateway executes an attachment-dependent intent only once those
    // hashes are uploaded and verified; evicting them makes the member's own
    // queued work unsendable from the one device that has it.
    const plan = planContentEviction(
      [
        entry("needed", 100, 1, false, { referencedByPendingIntent: true }),
        entry("old", 100, 2),
      ],
      100
    );
    expect(plan.evict).toStrictEqual(["old"]);
  });

  test("a store made entirely of protected bytes evicts nothing and says so", () => {
    // The overage is real and reported; silently evicting a promise to meet a
    // budget is the one thing this planner must not do.
    const plan = planContentEviction(
      [
        entry("a", 100, 1, true),
        entry("b", 100, 2, false, { capturedHere: true }),
      ],
      50
    );
    expect(plan.evict).toStrictEqual([]);
    expect(plan.pinnedBytes).toBe(200);
    expect(plan.overBudgetBy).toBe(150);
  });

  test("a thumb is refused rather than planned: it is a row, not a file", () => {
    expect(() =>
      planContentEviction([entry("t", 2_048, 1, false, { kind: "thumb" })], 1)
    ).toThrow(/thumb is a replicated row/u);
  });
});
