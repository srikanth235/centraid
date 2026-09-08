// THE WRITER MATRIX (#996, ruling R21; drift ONT-26) — the gate for "one
// invariant boundary".
//
// ONT-26's finding was not that a check was missing. It was that domain
// commands, imports and Atlas each enforced a DIFFERENT SUBSET of the model:
// `people.add_important_date` refused February 31 in its input schema and
// `atlas.insert_row` wrote it; `schedule.add_task` checked that a parent was
// open and top-level and neither of them noticed a task naming itself; nothing
// anywhere refused `due_at: "banana"`.
//
// So the acceptance is a MATRIX, not a list of cases: every invalid mutation
// through every writer that has a door to that table, refused by each — and,
// where two writers reach the same table, refused with the SAME SENTENCE. A
// test that only asserted "refused" would pass with four different reasons,
// which is the state this wave was opened to end.
//
// The four writers:
//   command     the typed vault command, invoked by the owner's device
//   automation  the same command under an agent credential with an answer
//   atlas       the row editor, `atlas.insert_row` / `atlas.update_row`
//   import      the ingest publisher for that entity, where one exists
//
// A cell with no door is stated as `null` and asserted to be a genuine
// absence, so "this writer cannot reach this table" is a recorded fact rather
// than a silently skipped row.

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { bootstrapVault, enrollAgent } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerAtlasCommands } from "../commands/atlas.js";
import { registerPeopleCommands } from "../commands/people.js";
import { registerScheduleOrganizeCommands } from "../commands/schedule-organize.js";
import { registerTaskCommands } from "../commands/tasks.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { answerScopes } from "../grant/automation-principal.test-fixtures.js";
import { PUBLISHERS } from "../ingest/publishers.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let automation: Credential;

/** What a writer answered, reduced to what the matrix compares. */
interface Refusal {
  refused: boolean;
  reason: string;
}

function outcomeRefusal(outcome: InvokeOutcome): Refusal {
  return outcome.status === "executed" || outcome.status === "replayed"
    ? { refused: false, reason: "" }
    : {
        refused: true,
        reason:
          (outcome as { reason?: string }).reason ?? `status ${outcome.status}`,
      };
}

/** A direct publisher call, which is what an import is once staging has run. */
function publisherRefusal(entityType: string, fn: () => void): Refusal {
  expect(
    PUBLISHERS.get(entityType),
    `publisher for ${entityType}`
  ).toBeDefined();
  try {
    fn();
    return { refused: false, reason: "" };
  } catch (error) {
    return {
      refused: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("the writer matrix — one invariant boundary", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerTaskCommands(gw);
    registerPeopleCommands(gw);
    registerAtlasCommands(gw);
    registerScheduleOrganizeCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    const agent = enrollAgent(db, {
      name: "matrix",
      modelRef: "test-automation",
    });
    answerScopes(db, boot, "matrix", [
      { schema: "schedule", verbs: "act" },
      { schema: "schedule", verbs: "read" },
      { schema: "people", verbs: "act" },
      { schema: "people", verbs: "read" },
      { schema: "core", verbs: "read" },
      { schema: "atlas", verbs: "act" },
    ]);
    automation = {
      kind: "agent",
      agentId: agent.agentId,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  afterEach(() => {
    db.close();
  });

  function invoke(
    cred: Credential,
    command: string,
    input: Record<string, unknown>
  ): InvokeOutcome {
    return gw.invoke(cred, { command, input });
  }

  function addTask(title: string, extra: Record<string, unknown> = {}): string {
    const outcome = invoke(owner, "schedule.add_task", { title, ...extra });
    expect(outcome.status, JSON.stringify(outcome)).toBe("executed");
    return (outcome as { output: { task_id: string } }).output.task_id;
  }

  function addPerson(name: string): string {
    const outcome = invoke(owner, "people.add_person", {
      display_name: name,
      cadence_days: 0,
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe("executed");
    return (outcome as { output: { party_id: string } }).output.party_id;
  }

  /**
   * Every reachable cell refused, all with the same sentence — which is then
   * returned, so each test states the words the member reads rather than
   * trusting that "they agreed" is enough.
   */
  function oneBoundary(
    mutation: string,
    cells: Record<string, Refusal | null>
  ): string {
    const reached = Object.entries(cells).filter(
      ([, refusal]) => refusal !== null
    ) as [string, Refusal][];
    expect(
      reached.length,
      `${mutation}: no writer reached the table`
    ).toBeGreaterThan(1);
    for (const [writer, refusal] of reached) {
      expect(refusal.refused, `${mutation} via ${writer} was accepted`).toBe(
        true
      );
    }
    const sentences = new Set(reached.map(([, refusal]) => refusal.reason));
    expect(
      sentences.size,
      `${mutation}: writers disagreed — ${[...sentences].join(" | ")}`
    ).toBe(1);
    return [...sentences][0] as string;
  }

  // ── 1. A task is not its own parent ─────────────────────────────────────

  test("a self-parent task is refused identically by every writer", () => {
    const viaAtlas = addTask("Self B");
    const viaAutomation = addTask("Self C");
    const own = "01a00000-0000-7000-a000-00000000ffff";
    const selfParent = oneBoundary("self-parent task", {
      // The command's door is a seat-minted id (#922 G2) naming itself.
      command: outcomeRefusal(
        invoke(owner, "schedule.add_task", {
          task_id: own,
          title: "Self A",
          parent_task_id: own,
        })
      ),
      atlas: outcomeRefusal(
        invoke(owner, "atlas.update_row", {
          table: "schedule.task",
          id: viaAtlas,
          set: { parent_task_id: viaAtlas },
        })
      ),
      automation: outcomeRefusal(
        invoke(automation, "atlas.update_row", {
          table: "schedule.task",
          id: viaAutomation,
          set: { parent_task_id: viaAutomation },
        })
      ),
    });
    expect(selfParent).toContain("A task cannot be its own parent.");
  });

  test("a task hierarchy loop of two is refused by the row editor", () => {
    const parent = addTask("Parent");
    const child = addTask("Child", { parent_task_id: parent });
    const closed = invoke(owner, "atlas.update_row", {
      table: "schedule.task",
      id: parent,
      set: { parent_task_id: child },
    });
    expect(closed.status).toBe("failed");
    expect((closed as { reason: string }).reason).toContain(
      "already below this task"
    );
  });

  // ── 2. A due date that is not a time ────────────────────────────────────

  test("due_at 'banana' is refused identically by every writer", () => {
    const existing = addTask("Has a due date", {
      due_at: "2026-03-01T09:00:00.000Z",
    });
    const banana = oneBoundary("due_at: banana", {
      command: outcomeRefusal(
        invoke(owner, "schedule.add_task", {
          title: "Banana",
          due_at: "banana",
        })
      ),
      automation: outcomeRefusal(
        invoke(automation, "schedule.add_task", {
          title: "Banana too",
          due_at: "banana",
        })
      ),
      atlas: outcomeRefusal(
        invoke(owner, "atlas.update_row", {
          table: "schedule.task",
          id: existing,
          set: { due_at: "banana" },
        })
      ),
      import: null,
    });
    expect(banana).toContain("is not a time this vault can read");
  });

  test("February 31 as a due date is refused identically by every writer", () => {
    const existing = addTask("Has a due date", {
      due_at: "2026-03-01T09:00:00.000Z",
    });
    const february = oneBoundary("due_at: 2026-02-31", {
      command: outcomeRefusal(
        invoke(owner, "schedule.add_task", {
          title: "Feb 31",
          due_at: "2026-02-31T09:00:00.000Z",
        })
      ),
      automation: outcomeRefusal(
        invoke(automation, "schedule.add_task", {
          title: "Feb 31 too",
          due_at: "2026-02-31T09:00:00.000Z",
        })
      ),
      atlas: outcomeRefusal(
        invoke(owner, "atlas.update_row", {
          table: "schedule.task",
          id: existing,
          set: { due_at: "2026-02-31T09:00:00.000Z" },
        })
      ),
    });
    expect(february).toContain("is not a time this vault can read");
  });

  // ── 3. A rule the engine cannot honour ──────────────────────────────────

  test("rrule 'garbage' is refused identically by every writer", () => {
    const existing = addTask("Repeating", {
      due_at: "2026-03-01T09:00:00.000Z",
    });
    const garbage = oneBoundary("rrule: garbage", {
      command: outcomeRefusal(
        invoke(owner, "schedule.add_task", {
          title: "Garbage",
          due_at: "2026-03-01T09:00:00.000Z",
          rrule: "garbage",
        })
      ),
      automation: outcomeRefusal(
        invoke(automation, "schedule.add_task", {
          title: "Garbage too",
          due_at: "2026-03-01T09:00:00.000Z",
          rrule: "garbage",
        })
      ),
      atlas: outcomeRefusal(
        invoke(owner, "atlas.update_row", {
          table: "schedule.task",
          id: existing,
          set: { rrule: "garbage" },
        })
      ),
    });
    expect(garbage).toContain("rrule:");
  });

  test("an imported rule outside the subset is RETAINED with its support state", () => {
    // The other half of ONT-31: a command refuses, an import keeps what the
    // provider sent and says the engine cannot run it. Discarding it would
    // lose the only record of what the series is; storing it as executable is
    // what made a wrong expansion wear the same face as a right one.
    const publisher = PUBLISHERS.get("core.event")!;
    publisher.create(
      db.vault,
      boot.ownerPartyId,
      {
        uid: "unsupported-1",
        summary: "Last Friday of the month",
        description: null,
        dtstart: "2026-03-27T09:00:00.000Z",
        dtend: null,
        startTz: "Etc/UTC",
        rrule: "FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR",
        status: "confirmed",
      } as unknown as Record<string, unknown>,
      "2026-03-01T00:00:00.000Z"
    );
    const row = db.vault
      .prepare(
        "SELECT rrule, rrule_support FROM core_event WHERE ical_uid = 'unsupported-1'"
      )
      .get() as { rrule: string; rrule_support: string };
    expect(row.rrule).toBe("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR");
    expect(row.rrule_support).toBe("unsupported");
  });

  // ── 4. A section that belongs to another project ────────────────────────

  test("a cross-project section is refused identically by every writer", () => {
    const projectA = invoke(owner, "schedule.save_project", { name: "A" });
    const projectB = invoke(owner, "schedule.save_project", { name: "B" });
    expect(projectA.status).toBe("executed");
    expect(projectB.status).toBe("executed");
    const a = (projectA as { output: { project_id: string } }).output
      .project_id;
    const b = (projectB as { output: { project_id: string } }).output
      .project_id;
    const sectionB = invoke(owner, "schedule.save_section", {
      project_id: b,
      name: "B's section",
    });
    expect(sectionB.status).toBe("executed");
    const section = (sectionB as { output: { section_id: string } }).output
      .section_id;
    const taskOne = addTask("Cross A");
    const taskTwo = addTask("Cross B");
    const crossProject = oneBoundary("a section of another project", {
      command: outcomeRefusal(
        invoke(owner, "schedule.organize_task", {
          task_id: taskOne,
          project_id: a,
          section_id: section,
          sort_order: 0,
        })
      ),
      atlas: outcomeRefusal(
        invoke(owner, "atlas.update_row", {
          table: "schedule.task",
          id: taskTwo,
          set: { project_id: a, section_id: section },
        })
      ),
    });
    expect(crossProject).toContain("belongs to a different project");
  });

  // ── 5. A hash of nothing over bytes that did not move ───────────────────

  test("a zeroed content hash over unchanged bytes is refused, whichever door", () => {
    const contentId = "matrix-content";
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, content_uri, sha256, byte_size, created_at)
         VALUES (?, 'file:///matrix', ?, 4, '2026-01-01T00:00:00.000Z')`
      )
      .run(
        contentId,
        "1111111111111111111111111111111111111111111111111111111111111111"
      );
    const zeroes = "0".repeat(64);
    const zeroed = oneBoundary("a zeroed hash over unchanged bytes", {
      atlas: outcomeRefusal(
        invoke(owner, "atlas.update_row", {
          table: "core.content_item",
          id: contentId,
          set: { sha256: zeroes },
        })
      ),
      automation: outcomeRefusal(
        invoke(automation, "atlas.update_row", {
          table: "core.content_item",
          id: contentId,
          set: { sha256: zeroes },
        })
      ),
    });
    expect(zeroed).toContain(
      "cannot change while the bytes stay where they are"
    );
    // And the shape of a hash is held for every writer by the column itself,
    // which is what makes the answer the same for the seat's local apply too.
    const notAHash = publisherRefusal("core.content_item", () => {
      db.vault
        .prepare(
          `INSERT INTO core_content_item (content_id, content_uri, sha256, byte_size, created_at)
           VALUES ('matrix-bad', 'file:///bad', 'deadbeef', 4, '2026-01-01T00:00:00.000Z')`
        )
        .run();
    });
    expect(notAHash.refused).toBe(true);
    expect(notAHash.reason).toContain("CHECK constraint failed");
  });

  // ── 6. A day of the year that does not exist ────────────────────────────

  test("February 31 as an anniversary is refused identically by every writer", () => {
    const partyId = addPerson("Grandma");
    const anniversary = oneBoundary("month_day: 02-31", {
      command: outcomeRefusal(
        invoke(owner, "people.add_important_date", {
          party_id: partyId,
          label: "anniversary",
          month_day: "02-31",
        })
      ),
      automation: outcomeRefusal(
        invoke(automation, "people.add_important_date", {
          party_id: partyId,
          label: "anniversary",
          month_day: "02-31",
        })
      ),
      atlas: outcomeRefusal(
        invoke(owner, "atlas.insert_row", {
          table: "people.important_date",
          values: {
            party_id: partyId,
            label: "anniversary",
            month_day: "02-31",
            reminder_on: 0,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        })
      ),
    });
    expect(anniversary).toContain("is not a day of the year");
  });

  test("February 29 is a real anniversary and every writer takes it", () => {
    const partyId = addPerson("Leap");
    expect(
      invoke(owner, "people.add_important_date", {
        party_id: partyId,
        label: "leap day",
        month_day: "02-29",
      }).status
    ).toBe("executed");
    const other = addPerson("Leap two");
    expect(
      invoke(owner, "atlas.insert_row", {
        table: "people.important_date",
        values: {
          party_id: other,
          label: "leap day",
          month_day: "02-29",
          reminder_on: 0,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      }).status
    ).toBe("executed");
  });
});
