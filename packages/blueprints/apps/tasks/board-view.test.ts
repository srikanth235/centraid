// The toolbar's rules (§4). What is asserted here is the pair of traps the
// toolbar exists to avoid: two chips that each read as additive taking the
// board to nothing, and a sort that quietly re-derives the member's own order.
import { describe, expect, it } from "vitest";

import {
  byManualOrder,
  byPriorityWithinDate,
  deniedFacts,
  lensHolds,
  lensedRows,
  nextSort,
  sortGroups,
  toggleLens,
  TASKS_SCOPE,
} from "./board-view.ts";
import type { Task } from "./types.ts";
import { DENIED } from "./view-copy.ts";

function task(patch: Partial<Task> & { task_id: string }): Task {
  return { status: "needs-action", title: patch.task_id, ...patch };
}

const QUICK = task({ task_id: "quick", effort_min: 15 });
const LONG = task({ task_id: "long", effort_min: 90 });
const UNSET = task({ task_id: "unset" });
const HOUSE = task({ task_id: "house", scope_id: "vault-2" });

describe("the three lenses", () => {
  it("counts only an effort that is set AND under the half hour", () => {
    expect(lensHolds("effort", QUICK)).toBe(true);
    expect(lensHolds("effort", LONG)).toBe(false);
    // Unset is not "small" — it is unanswered, and the lens asks a question.
    expect(lensHolds("effort", UNSET)).toBe(false);
  });

  it("splits the audience on the row's own scope stamp", () => {
    expect(lensHolds("house", HOUSE)).toBe(true);
    expect(lensHolds("mine", HOUSE)).toBe(false);
    expect(lensHolds("mine", UNSET)).toBe(true);
  });

  it("ANDs every held lens", () => {
    expect(lensedRows([QUICK, LONG, HOUSE], ["effort", "mine"])).toStrictEqual([
      QUICK,
    ]);
    expect(lensedRows([QUICK, LONG, HOUSE], [])).toHaveLength(3);
  });

  it("releases the sibling audience rather than emptying the board", () => {
    expect(toggleLens(["mine"], "house")).toStrictEqual(["house"]);
    expect(toggleLens(["mine", "effort"], "house")).toStrictEqual([
      "effort",
      "house",
    ]);
    expect(
      lensedRows([QUICK, HOUSE], toggleLens(["mine"], "house"))
    ).toStrictEqual([HOUSE]);
  });

  it("turns a held lens off again", () => {
    expect(toggleLens(["effort", "mine"], "effort")).toStrictEqual(["mine"]);
  });
});

describe("the sort toggle", () => {
  const early = task({ task_id: "early", due_at: "2026-08-21", priority: 1 });
  const late = task({ task_id: "late", due_at: "2026-08-22", priority: 3 });
  const sameDay = task({
    task_id: "same-day",
    due_at: "2026-08-21",
    priority: 3,
  });

  it("lets the date decide first and priority break its ties", () => {
    const rows = [early, late, sameDay].sort(byPriorityWithinDate);
    expect(rows.map((row) => row.task_id)).toStrictEqual([
      "same-day",
      "early",
      "late",
    ]);
  });

  it("reads manual order off `sort_order`, never off the date", () => {
    const rows = [
      task({ task_id: "b", sort_order: 2, due_at: "2026-08-01" }),
      task({ task_id: "a", sort_order: 1, due_at: "2026-09-01" }),
    ].sort(byManualOrder);
    expect(rows.map((row) => row.task_id)).toStrictEqual(["a", "b"]);
  });

  it("sorts within a group and keeps the group's own label", () => {
    const [group] = sortGroups(
      [{ key: "today", label: "Today", rows: [late, sameDay] }],
      "priority"
    );
    expect(group?.label).toBe("Today");
    expect(group?.rows.map((row) => row.task_id)).toStrictEqual([
      "same-day",
      "late",
    ]);
  });

  it("names the order the toggle would take, both ways", () => {
    expect(nextSort("priority")).toBe("manual");
    expect(nextSort("manual")).toBe("priority");
  });
});

describe("denial is data", () => {
  it("names the rows it wanted in the vault's own vocabulary", () => {
    expect(TASKS_SCOPE).toBe("schedule.task");
  });

  it("emits a row only for a fact the seat actually has", () => {
    expect(
      deniedFacts({ scope: TASKS_SCOPE, when: "2026-08-28 09:00" })
    ).toStrictEqual([
      { key: "scope", label: DENIED.scope, value: TASKS_SCOPE },
      { key: "when", label: DENIED.when, value: "2026-08-28 09:00" },
    ]);
    expect(
      deniedFacts({ receipt: null, scope: null, when: null })
    ).toStrictEqual([]);
  });
});
