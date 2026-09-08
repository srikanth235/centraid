// EVERY OPERATION DECLARES ITS CONTRACT (#996, rulings R21, R23, R25).
//
// R25's sentence is "apps invent none of this". The way an app ends up
// inventing it is not malice — it is an operation that never said what it
// promises offline, leaving each surface to guess whether to show the change
// immediately, whether a conflict is even possible, and whether the bytes have
// to be up before the write can run. So the declaration is data beside the
// operation, and this test is what stops one being added without it.
//
// The same for the read-set (R6/R23): an operation that does not say which
// rows it consulted cannot have its base versions checked, and an intent would
// settle against a version nobody looked at.

import { describe, expect, test } from "vitest";

import { DOMAIN_OPERATIONS } from "./registry.js";

describe("the domain operation declarations", () => {
  test("there is at least one operation and every name is unique", () => {
    expect(DOMAIN_OPERATIONS.length).toBeGreaterThan(0);
    const names = DOMAIN_OPERATIONS.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no operation has an empty precondition set — that was ONT-26", () => {
    for (const operation of DOMAIN_OPERATIONS) {
      expect(
        operation.preconditions.length,
        `${operation.name} declares no preconditions`
      ).toBeGreaterThan(0);
      expect(
        operation.postconditions.length,
        `${operation.name} declares no postconditions`
      ).toBeGreaterThan(0);
      for (const condition of [
        ...operation.preconditions,
        ...operation.postconditions,
      ]) {
        expect(
          condition.name.length,
          `${operation.name} has an unnamed condition`
        ).toBeGreaterThan(0);
        expect(condition.assert).toBeTypeOf("function");
      }
    }
  });

  test("every operation declares what it writes", () => {
    for (const operation of DOMAIN_OPERATIONS) {
      expect(
        operation.writes.length,
        `${operation.name} writes nothing`
      ).toBeGreaterThan(0);
    }
  });

  test("every operation carries R25's offline declaration, in full", () => {
    for (const operation of DOMAIN_OPERATIONS) {
      const offline = operation.offline;
      expect(
        ["offline", "online-only"],
        `${operation.name}.offline.submission`
      ).toContain(offline.submission);
      expect(
        ["optimistic", "hidden"],
        `${operation.name}.offline.pending`
      ).toContain(offline.pending);
      expect(
        ["none", "uploaded-and-verified"],
        `${operation.name}.offline.bytes`
      ).toContain(offline.bytes);
      expect(
        ["none", "gateway-authority"],
        `${operation.name}.offline.connectivity`
      ).toContain(offline.connectivity);
      expect(
        offline.conflictScope.length,
        `${operation.name} declares no conflict scope`
      ).toBeGreaterThan(0);
      // The reason a reviewer reads, not a shrug. An empty `why` is how a
      // declaration becomes a box someone ticked.
      expect(
        offline.why.length,
        `${operation.name}.offline.why is empty`
      ).toBeGreaterThan(40);
    }
  });

  test("an operation the seat cannot promise is unavailable, never queued", () => {
    // R25: an action that needs fresh gateway authority is explicitly
    // UNAVAILABLE offline, not queued — and a seat shows nothing optimistic
    // for a submission it could not make.
    const authorityQueued = DOMAIN_OPERATIONS.filter(
      (operation) =>
        operation.offline.connectivity === "gateway-authority" &&
        operation.offline.submission !== "online-only"
    ).map((operation) => operation.name);
    expect(authorityQueued).toStrictEqual([]);
    const optimisticButOnline = DOMAIN_OPERATIONS.filter(
      (operation) =>
        operation.offline.submission === "online-only" &&
        operation.offline.pending !== "hidden"
    ).map((operation) => operation.name);
    expect(optimisticButOnline).toStrictEqual([]);
  });

  test("the conflict scope is the read-set's entities, never something else", () => {
    // A probe input carrying every id any operation could ask for; whatever an
    // operation names back must sit inside the scope it declared.
    const probe = {
      task_id: "t",
      parent_task_id: "p",
      section_id: "s",
      party_id: "q",
      date_id: "d",
      content_id: "c",
      table: "schedule.task",
      id: "t",
    };
    const outside = DOMAIN_OPERATIONS.filter(
      (operation) => !operation.offline.conflictScope.includes("*")
    ).flatMap((operation) =>
      operation
        .readSet(probe)
        .filter(
          (entry) => !operation.offline.conflictScope.includes(entry.entity)
        )
        .map((entry) => `${operation.name} reads ${entry.entity}`)
    );
    expect(outside).toStrictEqual([]);
  });

  test("an operation that reads a row names it, so base versions can be checked", () => {
    const taskWrite = DOMAIN_OPERATIONS.find(
      (operation) => operation.name === "schedule.task.write"
    )!;
    expect(
      taskWrite.readSet({
        task_id: "task-1",
        parent_task_id: "task-0",
        section_id: "section-9",
      })
    ).toStrictEqual([
      { entity: "schedule.task", id: "task-1" },
      { entity: "schedule.task", id: "task-0" },
      { entity: "schedule.section", id: "section-9" },
    ]);
    // A creation with nothing to observe reads nothing, and says so.
    expect(taskWrite.readSet({ title: "New" })).toStrictEqual([]);
  });
});
