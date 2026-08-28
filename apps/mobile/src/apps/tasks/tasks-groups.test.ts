// Which rows a place asks for (#834). Every group is the blueprint's own
// answer, so what is asserted here is the ROUTING: a place either names one of
// those answers or declares that it draws a surface of its own — never falls
// through to Today's rows.

import { describe, expect, it } from "vitest";

import {
  allGroups,
  anytimeGroups,
  logbookGroups,
  todayGroups,
} from "@centraid/blueprints/apps/tasks/logic";
import type { Task } from "@centraid/blueprints/apps/tasks/types";
import { GROUPS } from "@centraid/blueprints/apps/tasks/view-copy";

import { findTask, flattenGroups, groupsFor } from "./tasks-groups";
import type { TasksPlaceKey } from "./tasks-places";

const NOW = "2026-08-21T09:00:00Z";

function task(patch: Partial<Task> & { task_id: string }): Task {
  return { status: "needs-action", title: patch.task_id, ...patch };
}

const TASKS: Task[] = [
  task({ task_id: "due", due_at: "2026-08-21" }),
  task({ task_id: "undated" }),
  task({ task_id: "closed", status: "completed", completed_at: NOW }),
];

const projectName = (): string => GROUPS.inbox;
const ask = (place: TasksPlaceKey) =>
  groupsFor({ place, tasks: TASKS, now: NOW, projectName });

describe("what each place asks for", () => {
  it("hands the board places the blueprint's own groups", () => {
    expect(ask("today")).toStrictEqual(todayGroups(TASKS, NOW));
    expect(ask("anytime")).toStrictEqual(anytimeGroups(TASKS, projectName));
    expect(ask("all")).toStrictEqual(allGroups(TASKS));
    expect(ask("logbook")).toStrictEqual(logbookGroups(TASKS));
  });

  it("gives the Inbox nothing to draw rather than an empty header", () => {
    expect(
      groupsFor({ place: "inbox", tasks: [], now: NOW, projectName })
    ).toStrictEqual([]);
    expect(ask("inbox")?.[0]?.label).toBe(GROUPS.inbox);
  });

  it("declares the places that draw a surface of their own", () => {
    for (const place of [
      "projects",
      "more",
      "search",
      "reentry",
      "notify",
    ] as const) {
      expect(ask(place)).toBeNull();
    }
  });
});

describe("the flat list the FlatList walks", () => {
  const parent = task({
    task_id: "p",
    due_at: "2026-08-21",
    children: [task({ task_id: "c" })],
  });

  it("puts a child directly under its parent, marked as a child", () => {
    const items = flattenGroups(todayGroups([parent], NOW));
    expect(items.map((item) => item.key)).toStrictEqual(["h:today", "p", "c"]);
    expect(items[2]).toMatchObject({ kind: "task", child: true });
  });

  it("finds a row inside a family, not only at its root", () => {
    expect(findTask([parent], "c")?.task_id).toBe("c");
    expect(findTask([parent], "p")?.task_id).toBe("p");
    expect(findTask([parent], null)).toBeUndefined();
    expect(findTask([parent], "missing")).toBeUndefined();
  });
});
