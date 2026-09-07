/*
 * THE PAGED DOOR, RED FIRST (#996 wave 4, ruling W4-D2).
 *
 * The claim under test is one sentence: a seat that holds no vault file reads
 * through the SAME statement-as-data as a seat that does, and the gateway runs
 * it under the caller's own principal with `evaluateAccess`, the R17 field mask
 * and the manifest row filters applied — never bypassed, and never as raw SQL.
 *
 * So each case here is a way that could go wrong:
 *
 *   1. it answers at all, keyset-paged, walking a set once with no gap and no
 *      overlap — otherwise the remote-only seat has no read path;
 *   2. it refuses the statements a grammar cannot check — a second statement, a
 *      comment, a subquery, an unlisted function — rather than escaping them;
 *   3. it refuses a table it cannot resolve to an entity, and a table this
 *      caller's access decision denies, on the far side of a join as much as
 *      the near side;
 *   4. it refuses a column the field mask does not carry, and a sealed one,
 *      because a page is a read and plaintext takes `reveal`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { openOwnerVault } from "./owner-vault.test-fixtures.js";
import type { OwnerVault } from "./owner-vault.test-fixtures.js";
import type { Credential } from "./types.js";

const TASKS = {
  name: "tasks.board",
  select: "task_id, title, status",
  from: "schedule_task",
  where: "status = ?",
  bind: ["needs-action"],
  order: { sortColumn: "task_id", pkColumn: "task_id", descending: false },
} as const;

let vault: OwnerVault;

/** The vault's own party row: `schedule_task.owner_party_id` is NOT NULL. */
function ownerPartyId(): string {
  const row = vault.db.vault
    .prepare(`SELECT party_id FROM core_party LIMIT 1`)
    .get() as { party_id: string };
  return row.party_id;
}

function seedTasks(count: number): void {
  const party = ownerPartyId();
  for (let index = 0; index < count; index += 1) {
    const taskId = `task_${String(index).padStart(3, "0")}`;
    vault.db.vault
      .prepare(
        `INSERT INTO core_entity (entity_id, entity_type, created_at)
         VALUES (?, 'schedule.task', '2026-01-01T00:00:00Z')`
      )
      .run(taskId);
    vault.db.vault
      .prepare(
        `INSERT INTO schedule_task
           (task_id, owner_party_id, title, status, priority,
            created_at, updated_at)
         VALUES (?, ?, ?, 'needs-action', 0,
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .run(taskId, party, `Task ${index}`);
  }
}

describe("the door answers", () => {
  beforeEach(() => {
    vault = openOwnerVault();
  });

  it("pages a set once, with no gap and no overlap", () => {
    seedTasks(7);
    const seen: string[] = [];
    let after: { sortKey: string; pk: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = vault.gateway.page(vault.owner, TASKS, {
        limit: 3,
        ...(after ? { after } : {}),
      });
      for (const row of page.rows) seen.push(row.task_id as string);
      expect(page.rows.length).toBeLessThanOrEqual(3);
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("drops the probe row and names where to continue", () => {
    // The statement asks for one row more than the window. That row is what
    // separates "the window filled" from "the rows ended", and a handler that
    // received it would report a full set as a short one — which is the
    // announcement `truncated` used to make, and got wrong.
    seedTasks(25);
    const page = vault.gateway.page(vault.owner, TASKS, { limit: 20 });
    expect(page.rows).toHaveLength(20);
    expect(page.next).toStrictEqual({
      sortKey: "task_019",
      pk: "task_019",
    });
    const last = vault.gateway.page(vault.owner, TASKS, {
      limit: 20,
      after: page.next!,
    });
    expect(last.rows).toHaveLength(5);
    expect(last.next).toBeUndefined();
  });

  it("honours the handler's own predicate and its binds", () => {
    seedTasks(3);
    vault.db.vault
      .prepare(
        `UPDATE schedule_task SET status = 'completed' WHERE task_id = ?`
      )
      .run("task_001");
    const page = vault.gateway.page(vault.owner, TASKS, { limit: 50 });
    expect(page.rows.map((row) => row.task_id)).toStrictEqual([
      "task_000",
      "task_002",
    ]);
  });
});

describe("the door refuses what it cannot check", () => {
  beforeEach(() => {
    vault = openOwnerVault();
  });

  /** The page this statement would be, as a thunk the assertion runs. */
  const paging = (query: Record<string, unknown>) => (): unknown =>
    vault.gateway.page(vault.owner, { ...TASKS, ...query } as never, {
      limit: 5,
    });

  it("refuses a second statement and a comment", () => {
    expect(paging({ where: "1=1; DROP TABLE schedule_task" })).toThrow(
      /separator|comment/u
    );
    expect(paging({ where: "1=1 -- and the rest" })).toThrow(
      /separator|comment/u
    );
  });

  it("refuses a subquery, in the projection and in the FROM", () => {
    expect(
      paging({ select: "task_id, (SELECT secret FROM locker_item) AS x" })
    ).toThrow(/nested SELECT/u);
    expect(paging({ from: "(SELECT * FROM schedule_task)" })).toThrow(
      /subquery/u
    );
  });

  it("refuses a function the door's list does not name", () => {
    expect(paging({ select: "task_id, readfile(title) AS x" })).toThrow(
      /not on the door's list/u
    );
  });

  it("refuses a table that is not an entity of this vault", () => {
    expect(paging({ from: "sqlite_master" })).toThrow(/not an entity/u);
  });

  it("refuses a column no table in the statement has", () => {
    expect(paging({ select: "task_id, nonesuch" })).toThrow(
      /no table in the statement has/u
    );
  });

  it("refuses an unqualified column two joined tables both carry", () => {
    expect(
      paging({
        from: "schedule_task JOIN schedule_project ON schedule_task.project_id = schedule_project.project_id",
        select: "schedule_task.task_id, created_at",
      })
    ).toThrow(/unqualified and more than one table has it/u);
  });
});

describe("the door applies the caller's own decision", () => {
  beforeEach(() => {
    vault = openOwnerVault();
  });

  /** An app credential clamped to its declared manifest, as `bridgeFor` builds it. */
  const clamped = (
    scopeClamp: NonNullable<Credential["scopeClamp"]>
  ): Credential => ({
    kind: "device",
    deviceId: vault.boot.deviceId,
    deviceKey: vault.boot.deviceKey,
    surface: "com.centraid.tasks",
    scopeClamp,
  });

  it("refuses a table the clamp does not carry, on either side of a join", () => {
    seedTasks(1);
    expect(() =>
      vault.gateway.page(
        clamped([{ schema: "schedule", table: "task", verbs: "read" }]),
        {
          ...TASKS,
          from: "schedule_task JOIN schedule_project ON schedule_task.project_id = schedule_project.project_id",
          select: "schedule_task.task_id, schedule_project.name",
          order: {
            sortColumn: "schedule_task.task_id",
            pkColumn: "schedule_task.task_id",
            descending: false,
          },
        } as never,
        { limit: 5 }
      )
    ).toThrow(/schedule\.project/u);
  });

  it("refuses a column the field mask does not carry", () => {
    seedTasks(1);
    expect(() =>
      vault.gateway.page(
        clamped([
          {
            schema: "schedule",
            table: "task",
            verbs: "read",
            fieldMask: ["task_id", "status"],
          },
        ]),
        TASKS,
        { limit: 5 }
      )
    ).toThrow(/field mask does not carry/u);
  });

  it("splices the clamp's row filter into the statement it was not written for", () => {
    seedTasks(3);
    const page = vault.gateway.page(
      clamped([
        {
          schema: "schedule",
          table: "task",
          verbs: "read",
          rowFilter: [{ column: "task_id", op: "eq", value: "task_001" }],
        },
      ]),
      { ...TASKS, where: undefined, bind: [] } as never,
      { limit: 50 }
    );
    expect(page.rows.map((row) => row.task_id)).toStrictEqual(["task_001"]);
  });
});
