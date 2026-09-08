import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerTaskCommands } from "./tasks.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("tasks", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerTaskCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function addTask(input: Record<string, unknown>): string {
    const outcome = gw.invoke(owner, {
      command: "schedule.add_task",
      input,
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { task_id: string } }).output.task_id;
  }

  test("add_task creates an open VTODO with defaults and provenance", () => {
    const taskId = addTask({
      title: "File the GST return",
      due_at: "2026-07-20",
      priority: 1,
    });
    const row = db.vault
      .prepare("SELECT * FROM schedule_task WHERE task_id = ?")
      .get(taskId);
    expect(row).toMatchObject({
      title: "File the GST return",
      status: "needs-action",
      priority: 1,
      due_at: "2026-07-20",
      completed_at: null,
      owner_party_id: boot.ownerPartyId,
    });
    const prov = db.audit
      .prepare(
        `SELECT count(*) AS n FROM access_provenance
        WHERE entity_type='schedule.task' AND entity_id=? AND prov_activity='command.schedule.add_task'`
      )
      .get(taskId) as { n: number };
    expect(prov.n).toBe(1);
  });

  test("add_task nests one level: subtask of a subtask is refused", () => {
    const parent = addTask({ title: "Plan the trip" });
    const child = addTask({ title: "Book flights", parent_task_id: parent });
    const grandchild = gw.invoke(owner, {
      command: "schedule.add_task",
      input: { title: "Pick seats", parent_task_id: child },
    });
    expect(grandchild.status).toBe("failed");
    assert(grandchild.status === "failed");
    expect(grandchild.predicate).toContain("parent_open_and_top_level");
  });

  test("add_task under a missing or closed parent is refused", () => {
    const missing = gw.invoke(owner, {
      command: "schedule.add_task",
      input: { title: "Orphan", parent_task_id: "no-such-task" },
    });
    expect(missing.status).toBe("failed");
    const parent = addTask({ title: "Done project" });
    gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: parent, status: "completed" },
    });
    const late = gw.invoke(owner, {
      command: "schedule.add_task",
      input: { title: "Too late", parent_task_id: parent },
    });
    expect(late.status).toBe("failed");
  });

  test("set_task_status completes with a stamp and reopening clears it", () => {
    const taskId = addTask({ title: "Water the plants" });
    const done = gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: taskId, status: "completed" },
    });
    expect(done.status).toBe("executed");
    let row = db.vault
      .prepare(
        "SELECT status, completed_at FROM schedule_task WHERE task_id = ?"
      )
      .get(taskId) as { status: string; completed_at: string | null };
    expect(row.status).toBe("completed");
    expect(row.completed_at).not.toBeNull();

    const reopened = gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: taskId, status: "needs-action" },
    });
    expect(reopened.status).toBe("executed");
    row = db.vault
      .prepare(
        "SELECT status, completed_at FROM schedule_task WHERE task_id = ?"
      )
      .get(taskId) as { status: string; completed_at: string | null };
    expect(row).toMatchObject({ status: "needs-action", completed_at: null });
  });

  test("set_task_status on an unknown task is refused by precondition", () => {
    const outcome = gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: "ghost", status: "completed" },
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.predicate).toContain("task_exists");
  });

  test("add_task with an rrule but no due_at is refused", () => {
    const outcome = gw.invoke(owner, {
      command: "schedule.add_task",
      input: { title: "Water the plants", rrule: "FREQ=WEEKLY" },
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.predicate).toContain("needs a due date to repeat");
  });

  test("completing a repeating task spawns its next occurrence", () => {
    const taskId = addTask({
      title: "Water the plants",
      due_at: "2026-07-06T09:00:00.000Z",
      priority: 3,
      rrule: "FREQ=WEEKLY",
    });
    const outcome = gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: taskId, status: "completed" },
    });
    expect(outcome.status).toBe("executed");
    const output = (
      outcome as { output: { next_task_id?: string; next_due_at?: string } }
    ).output;
    expect(output.next_task_id).toBeTruthy();
    expect(output.next_due_at).toBe("2026-07-13T09:00:00.000Z");
    const original = db.vault
      .prepare(
        "SELECT status, completed_at FROM schedule_task WHERE task_id = ?"
      )
      .get(taskId) as { status: string; completed_at: string | null };
    expect(original.status).toBe("completed");
    expect(original.completed_at).not.toBeNull();
    const next = db.vault
      .prepare(
        "SELECT title, priority, status, due_at, rrule, completed_at FROM schedule_task WHERE task_id = ?"
      )
      .get(output.next_task_id as string) as {
      title: string;
      priority: number;
      status: string;
      due_at: string;
      rrule: string;
      completed_at: string | null;
    };
    expect(next).toMatchObject({
      title: "Water the plants",
      priority: 3,
      status: "needs-action",
      due_at: "2026-07-13T09:00:00.000Z",
      rrule: "FREQ=WEEKLY",
      completed_at: null,
    });
  });

  test("completing a non-repeating task spawns nothing", () => {
    const taskId = addTask({ title: "One-off errand", due_at: "2026-07-06" });
    const outcome = gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: taskId, status: "completed" },
    });
    expect(outcome.status).toBe("executed");
    const output = (outcome as { output: { next_task_id?: string } }).output;
    expect(output.next_task_id).toBeUndefined();
  });

  test("completing the last occurrence of a bounded series spawns nothing", () => {
    const taskId = addTask({
      title: "Last check-in",
      due_at: "2026-07-06T09:00:00.000Z",
      rrule: "FREQ=WEEKLY;COUNT=1",
    });
    const outcome = gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: taskId, status: "completed" },
    });
    expect(outcome.status).toBe("executed");
    const output = (outcome as { output: { next_task_id?: string } }).output;
    expect(output.next_task_id).toBeUndefined();
  });

  test("add_task with a reminder but no due_at is refused", () => {
    const outcome = gw.invoke(owner, {
      command: "schedule.add_task",
      input: { title: "Call the dentist", remind_before_min: 30 },
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.predicate).toContain("needs a due date to count back");
  });

  test("edit_task sets and clears rrule; setting it on a task with no due_at is refused", () => {
    const withDue = addTask({
      title: "Weekly review",
      due_at: "2026-07-06T09:00:00.000Z",
    });
    const set = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: withDue, rrule: "FREQ=WEEKLY" },
    });
    expect(set.status).toBe("executed");
    let row = db.vault
      .prepare("SELECT rrule FROM schedule_task WHERE task_id = ?")
      .get(withDue) as {
      rrule: string | null;
    };
    expect(row.rrule).toBe("FREQ=WEEKLY");

    const cleared = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: withDue, clear_rrule: true },
    });
    expect(cleared.status).toBe("executed");
    row = db.vault
      .prepare("SELECT rrule FROM schedule_task WHERE task_id = ?")
      .get(withDue) as {
      rrule: string | null;
    };
    expect(row.rrule).toBeNull();

    const noDue = addTask({ title: "Someday task" });
    const refused = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: noDue, rrule: "FREQ=DAILY" },
    });
    expect(refused.status).toBe("failed");
    assert(refused.status === "failed");
    expect(refused.predicate).toContain("needs a due date to repeat");
  });

  test("edit_task sets and clears remind_before_min; sending both is refused", () => {
    const taskId = addTask({
      title: "Call the dentist",
      due_at: "2026-07-10T09:00:00.000Z",
    });
    const set = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, remind_before_min: 15 },
    });
    expect(set.status).toBe("executed");
    let row = db.vault
      .prepare("SELECT remind_before_min FROM schedule_task WHERE task_id = ?")
      .get(taskId) as { remind_before_min: number | null };
    expect(row.remind_before_min).toBe(15);

    const both = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, remind_before_min: 5, clear_remind: true },
    });
    expect(both.status).toBe("failed");

    const cleared = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, clear_remind: true },
    });
    expect(cleared.status).toBe("executed");
    row = db.vault
      .prepare("SELECT remind_before_min FROM schedule_task WHERE task_id = ?")
      .get(taskId) as { remind_before_min: number | null };
    expect(row.remind_before_min).toBeNull();
  });

  test("a recurring task carries its reminder forward to the next occurrence", () => {
    const taskId = addTask({
      title: "Water the plants",
      due_at: "2026-07-06T09:00:00.000Z",
      rrule: "FREQ=WEEKLY",
      remind_before_min: 20,
    });
    const outcome = gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: taskId, status: "completed" },
    });
    const nextId = (outcome as { output: { next_task_id?: string } }).output
      .next_task_id;
    const next = db.vault
      .prepare("SELECT remind_before_min FROM schedule_task WHERE task_id = ?")
      .get(nextId as string) as { remind_before_min: number | null };
    expect(next.remind_before_min).toBe(20);
  });

  test("edit_task updates only the fields sent and reads them back", () => {
    const taskId = addTask({
      title: "Draft the proposal",
      due_at: "2026-07-10",
      priority: 5,
    });
    const outcome = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: {
        task_id: taskId,
        title: "Draft + send the proposal",
        priority: 1,
        effort_min: 90,
      },
    });
    expect(outcome.status).toBe("executed");
    const row = db.vault
      .prepare("SELECT * FROM schedule_task WHERE task_id = ?")
      .get(taskId);
    expect(row).toMatchObject({
      title: "Draft + send the proposal",
      priority: 1,
      effort_min: 90,
      due_at: "2026-07-10", // untouched
    });
  });

  test("edit_task clear_due removes the date; sending due_at with clear_due is refused", () => {
    const taskId = addTask({ title: "Someday item", due_at: "2026-08-01" });
    const cleared = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, clear_due: true },
    });
    expect(cleared.status).toBe("executed");
    const row = db.vault
      .prepare("SELECT due_at FROM schedule_task WHERE task_id = ?")
      .get(taskId) as { due_at: string | null };
    expect(row.due_at).toBeNull();

    const both = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, due_at: "2026-08-02", clear_due: true },
    });
    expect(both.status).toBe("failed");
    assert(both.status === "failed");
    expect(both.predicate).toContain("due_set_and_clear_are_exclusive");
  });

  test("description rides add_task, edit_task sets it, clear_description removes it", () => {
    const taskId = addTask({
      title: "Book flights",
      description: "Window seat if possible",
    });
    let row = db.vault
      .prepare("SELECT description FROM schedule_task WHERE task_id = ?")
      .get(taskId) as { description: string | null };
    expect(row.description).toBe("Window seat if possible");

    const edited = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, description: "Aisle seat, actually" },
    });
    expect(edited.status).toBe("executed");

    const titled = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, title: "Book flights to Goa" },
    });
    expect(titled.status).toBe("executed");
    row = db.vault
      .prepare("SELECT description FROM schedule_task WHERE task_id = ?")
      .get(taskId) as {
      description: string | null;
    };
    expect(row.description).toBe("Aisle seat, actually");

    const cleared = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, clear_description: true },
    });
    expect(cleared.status).toBe("executed");
    row = db.vault
      .prepare("SELECT description FROM schedule_task WHERE task_id = ?")
      .get(taskId) as {
      description: string | null;
    };
    expect(row.description).toBeNull();

    const both = gw.invoke(owner, {
      command: "schedule.edit_task",
      input: { task_id: taskId, description: "x", clear_description: true },
    });
    expect(both.status).toBe("failed");
  });

  test("delete_task trashes the row and its subtasks, not a cancelled status", () => {
    const parent = addTask({ title: "Plan the trip" });
    const child = addTask({ title: "Book flights", parent_task_id: parent });
    const outcome = gw.invoke(owner, {
      command: "schedule.delete_task",
      input: { task_id: parent },
    });
    expect(outcome.status).toBe("executed");
    // Trashing is not cancelling: the status is untouched.
    const rows = db.vault
      .prepare(
        `SELECT task_id, status, deleted_at IS NOT NULL AS trashed,
                purge_at IS NOT NULL AS scheduled
           FROM schedule_task WHERE task_id IN (?, ?) ORDER BY title`
      )
      .all(parent, child) as {
      task_id: string;
      status: string;
      trashed: number;
      scheduled: number;
    }[];
    expect(rows.map((row) => ({ ...row }))).toStrictEqual([
      { task_id: child, status: "needs-action", trashed: 1, scheduled: 1 },
      { task_id: parent, status: "needs-action", trashed: 1, scheduled: 1 },
    ]);
  });

  test("restore_task brings back the branch that was trashed with it", () => {
    const parent = addTask({ title: "Plan the trip" });
    const child = addTask({ title: "Book flights", parent_task_id: parent });
    gw.invoke(owner, {
      command: "schedule.delete_task",
      input: { task_id: parent },
    });
    const restored = gw.invoke(owner, {
      command: "schedule.restore_task",
      input: { task_id: parent },
    });
    expect(restored.status).toBe("executed");
    expect(
      db.vault
        .prepare(
          `SELECT count(*) AS n FROM schedule_task
            WHERE task_id IN (?, ?) AND deleted_at IS NULL AND purge_at IS NULL`
        )
        .get(parent, child)
    ).toMatchObject({ n: 2 });
  });

  test("a trashed task is not there to act on until it is restored", () => {
    const taskId = addTask({ title: "Plan the trip" });
    gw.invoke(owner, {
      command: "schedule.delete_task",
      input: { task_id: taskId },
    });
    const outcome = gw.invoke(owner, {
      command: "schedule.set_task_status",
      input: { task_id: taskId, status: "completed" },
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.predicate).toContain("task_exists");
  });

  test("delete_task on an unknown task is refused by precondition", () => {
    const outcome = gw.invoke(owner, {
      command: "schedule.delete_task",
      input: { task_id: "ghost" },
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.predicate).toContain("task_exists");
  });

  // #922 G2: the id the member's seat showed IS the row's id, so an offline
  // child write filed against it lands pointing at the same task.
  test("honours a seat-minted task id, and refuses it the second time", () => {
    const minted = "1f2e3d4c-0000-8000-8000-0000000000aa";
    expect(addTask({ task_id: minted, title: "Grout" })).toBe(minted);
    const again = gw.invoke(owner, {
      command: "schedule.add_task",
      input: { task_id: minted, title: "Grout again" },
    });
    expect(again.status).not.toBe("executed");
    // The refused write left the first row exactly as it was.
    expect(
      db.vault
        .prepare("SELECT title FROM schedule_task WHERE task_id = ?")
        .get(minted)
    ).toMatchObject({ title: "Grout" });
  });

  // A row id the CALLER chose has a shape the origin enforces. Honouring any
  // non-empty string would have made the primary key caller-controlled prose.
  test("refuses a minted id that is not a UUID", () => {
    for (const bad of [
      "  ",
      "'; DROP TABLE schedule_task; --",
      "x".repeat(5_000),
      "1f2e3d4c-0000-0000-8000-0000000000aa",
    ]) {
      const outcome = gw.invoke(owner, {
        command: "schedule.add_task",
        input: { task_id: bad, title: "Shaped like nothing" },
      });
      expect(outcome.status, `${bad.slice(0, 24)} must be refused`).not.toBe(
        "executed"
      );
    }
    expect(
      db.vault.prepare("SELECT count(*) AS n FROM schedule_task").get() as {
        n: number;
      }
    ).toMatchObject({ n: 0 });
  });
});
