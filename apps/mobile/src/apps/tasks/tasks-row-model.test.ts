// The row's own two omissions (#882): overdue reached the row as one faint
// colour because every part was flattened to `.text`, and priority never
// reached it at all.

import { describe, expect, it } from "vitest";

import type { Task } from "@centraid/blueprints/apps/tasks/types";

import { taskRowModel } from "./tasks-row-model";

const NOW = "2026-08-28T09:00:00Z";

function task(patch: Partial<Task> & { task_id: string }): Task {
  return { status: "needs-action", title: patch.task_id, ...patch };
}

describe("the attention tone reaching the row", () => {
  it("marks the overdue due date, and only that part", () => {
    const model = taskRowModel({
      task: task({ task_id: "late", due_at: "2026-08-20" }),
      now: NOW,
      projectName: "Kitchen",
    });
    expect(model.meta.map((part) => part.attention === true)).toStrictEqual([
      false,
      true,
    ]);
  });

  it("leaves a due date that has not passed untoned", () => {
    const model = taskRowModel({
      task: task({ task_id: "soon", due_at: "2026-08-29" }),
      now: NOW,
    });
    expect(model.meta.some((part) => part.attention)).toBe(false);
  });
});

describe("priority on the row", () => {
  it("says nothing at all when nobody set one", () => {
    expect(
      taskRowModel({ task: task({ task_id: "a" }), now: NOW }).priority
    ).toBeNull();
    expect(
      taskRowModel({ task: task({ task_id: "a", priority: 0 }), now: NOW })
        .priority
    ).toBeNull();
  });

  it("names the level in the editor's own words", () => {
    expect(
      taskRowModel({ task: task({ task_id: "a", priority: 3 }), now: NOW })
        .priority
    ).toBe("Now");
    expect(
      taskRowModel({ task: task({ task_id: "a", priority: 1 }), now: NOW })
        .priority
    ).toBe("Soon");
  });
});
