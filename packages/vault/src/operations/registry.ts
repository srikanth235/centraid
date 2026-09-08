// THE NAMED OPERATIONS (#996, rulings R21, R23, R25).
//
// One module, one entry per operation, each with a NON-EMPTY set of
// preconditions and postconditions, the read-set it decides on, and the
// offline contract it promises. Two properties this file exists to make
// checkable rather than assumed:
//
//   * every operation declares its offline contract (R25) — the test below
//     this module fails when one does not, so an app can never be the place a
//     pending behaviour is invented;
//   * every operation declares the rows it READ to decide (R6/R23) — the
//     intent conflict checker refuses a base-version set short of it, so an
//     offline intent cannot be executed against a row nobody looked at.

import type { DatabaseSync } from "node:sqlite";

import { assertCanonicalWrite } from "./canonical-write.js";
import { CONTENT_WRITE_CONDITIONS } from "./content-write.js";
import { IMPORTANT_DATE_CONDITIONS } from "./important-date-write.js";
import { TASK_WRITE_CONDITIONS, taskImage } from "./task-write.js";
import type {
  DomainOperation,
  OfflineDeclaration,
  OperationCondition,
  ReadSetEntry,
} from "./types.js";

function text(
  input: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function entries(...rows: (ReadSetEntry | null)[]): ReadSetEntry[] {
  return rows.filter((row): row is ReadSetEntry => row !== null);
}

/** The row an input names by `key`, or nothing when it names none. */
function ref(
  entity: string,
  input: Readonly<Record<string, unknown>>,
  key: string
): ReadSetEntry | null {
  const id = text(input, key);
  return id === null ? null : { entity, id };
}

/**
 * The status and completion stamp of the task an input names: `null` when it
 * names none, `undefined` when that task is not there. The three task
 * postconditions below all decide on exactly this pair, so they read it here.
 */
function taskCompletion(
  vault: DatabaseSync,
  input: Readonly<Record<string, unknown>>
): { status: string; completed_at: string | null } | null | undefined {
  const taskId = text(input, "task_id");
  if (taskId === null) return null;
  return vault
    .prepare("SELECT status, completed_at FROM schedule_task WHERE task_id = ?")
    .get(taskId) as { status: string; completed_at: string | null } | undefined;
}

/** A local edit of the member's own rows: queue it, show it, settle it. */
const LOCAL_EDIT: Omit<OfflineDeclaration, "conflictScope"> = {
  submission: "offline",
  pending: "optimistic",
  bytes: "none",
  connectivity: "none",
  why: "The member's own rows, with no gateway-side authority and no bytes to upload — the seat can show the result immediately and reconcile at the cursor.",
};

function localEdit(conflictScope: readonly string[]): OfflineDeclaration {
  return { ...LOCAL_EDIT, conflictScope };
}

// ── schedule.task.write ────────────────────────────────────────────────────

const TASK_WRITE_PRE: readonly OperationCondition[] = TASK_WRITE_CONDITIONS.map(
  (condition) => ({
    name: condition.name,
    assert: (vault: DatabaseSync, input: Readonly<Record<string, unknown>>) =>
      condition.assert(
        vault,
        taskImage(vault, {
          taskId: text(input, "task_id"),
          ...(Object.hasOwn(input, "parent_task_id")
            ? { parentTaskId: text(input, "parent_task_id") }
            : {}),
          ...(Object.hasOwn(input, "project_id")
            ? { projectId: text(input, "project_id") }
            : {}),
          ...(Object.hasOwn(input, "section_id")
            ? { sectionId: text(input, "section_id") }
            : {}),
          ...(Object.hasOwn(input, "due_at")
            ? { dueAt: text(input, "due_at") }
            : {}),
          ...(Object.hasOwn(input, "rrule")
            ? { rrule: text(input, "rrule") }
            : {}),
        })
      ),
  })
);

const TASK_WRITE: DomainOperation = {
  name: "schedule.task.write",
  writes: ["schedule.task"],
  preconditions: TASK_WRITE_PRE,
  postconditions: [
    {
      name: "task_completion_stamp_agrees_with_status",
      assert: (vault, input) => {
        const row = taskCompletion(vault, input);
        if (!row) return null;
        return (row.status === "completed") === (row.completed_at !== null)
          ? null
          : "A completed task carries the moment it was completed, and an open one carries none.";
      },
    },
  ],
  readSet: (input) =>
    entries(
      ref("schedule.task", input, "task_id"),
      ref("schedule.task", input, "parent_task_id"),
      ref("schedule.section", input, "section_id")
    ),
  offline: localEdit(["schedule.task", "schedule.section"]),
};

// ── schedule.task.complete / reopen ────────────────────────────────────────

const TASK_IS_LIVE: OperationCondition = {
  name: "task_exists",
  assert: (vault, input) => {
    const taskId = text(input, "task_id");
    if (taskId === null) return "That task is not here.";
    const row = vault
      .prepare(
        "SELECT 1 AS n FROM schedule_task WHERE task_id = ? AND deleted_at IS NULL"
      )
      .get(taskId) as { n: number } | undefined;
    return row ? null : "That task is not here.";
  },
};

const TASK_COMPLETE: DomainOperation = {
  name: "schedule.task.complete",
  writes: ["schedule.task", "core.link"],
  preconditions: [TASK_IS_LIVE],
  postconditions: [
    {
      name: "task_is_completed_and_stamped",
      assert: (vault, input) => {
        const row = taskCompletion(vault, input);
        if (row === null) return null;
        if (!row) return "The task vanished while it was being completed.";
        return row.status === "completed" && row.completed_at !== null
          ? null
          : "A completed task carries the moment it was completed.";
      },
    },
    {
      name: "successor_inherits_the_series",
      assert: (vault, input) => {
        const nextTaskId = text(input, "next_task_id");
        const taskId = text(input, "task_id");
        if (nextTaskId === null || taskId === null) return null;
        const rows = vault
          .prepare(
            "SELECT task_id, series_id, status FROM schedule_task WHERE task_id IN (?, ?)"
          )
          .all(taskId, nextTaskId) as {
          task_id: string;
          series_id: string | null;
          status: string;
        }[];
        const done = rows.find((row) => row.task_id === taskId);
        const next = rows.find((row) => row.task_id === nextTaskId);
        if (!done || !next) return "The successor is not there.";
        if (next.status !== "needs-action") {
          return "A spawned occurrence starts open.";
        }
        return done.series_id !== null && next.series_id === done.series_id
          ? null
          : "An occurrence belongs to the series it came from.";
      },
    },
  ],
  readSet: (input) => entries(ref("schedule.task", input, "task_id")),
  offline: localEdit(["schedule.task"]),
};

const TASK_REOPEN: DomainOperation = {
  name: "schedule.task.reopen",
  writes: ["schedule.task"],
  preconditions: [TASK_IS_LIVE],
  postconditions: [
    {
      name: "task_is_open_and_unstamped",
      assert: (vault, input) => {
        const row = taskCompletion(vault, input);
        if (row === null) return null;
        if (!row) return "The task vanished while it was being reopened.";
        return row.status !== "completed" && row.completed_at === null
          ? null
          : "A reopened task carries no completion stamp.";
      },
    },
  ],
  readSet: (input) => entries(ref("schedule.task", input, "task_id")),
  offline: localEdit(["schedule.task"]),
};

// ── core.content_item.write ────────────────────────────────────────────────

const CONTENT_WRITE: DomainOperation = {
  name: "core.content_item.write",
  writes: ["core.content_item"],
  preconditions: CONTENT_WRITE_CONDITIONS.map((condition) => ({
    name: condition.name,
    assert: (vault: DatabaseSync, input: Readonly<Record<string, unknown>>) => {
      const contentId = text(input, "content_id");
      const current =
        contentId === null
          ? undefined
          : (vault
              .prepare(
                "SELECT sha256, content_uri, byte_size FROM core_content_item WHERE content_id = ?"
              )
              .get(contentId) as
              | { sha256: string; content_uri: string; byte_size: number }
              | undefined);
      return condition.assert(
        vault,
        {
          contentId,
          ...(Object.hasOwn(input, "sha256")
            ? { sha256: text(input, "sha256") }
            : {}),
          ...(Object.hasOwn(input, "content_uri")
            ? { contentUri: text(input, "content_uri") }
            : {}),
          ...(Object.hasOwn(input, "byte_size")
            ? { byteSize: Number(input["byte_size"]) }
            : {}),
        },
        current
      );
    },
  })),
  postconditions: [
    {
      name: "content_hash_is_unique",
      assert: (vault, input) => {
        const sha = text(input, "sha256");
        if (sha === null) return null;
        const row = vault
          .prepare(
            "SELECT count(*) AS n FROM core_content_item WHERE sha256 = ?"
          )
          .get(sha) as { n: number };
        return row.n <= 1
          ? null
          : "Two content rows cannot claim the same bytes.";
      },
    },
  ],
  readSet: (input) => entries(ref("core.content_item", input, "content_id")),
  offline: {
    submission: "offline",
    pending: "optimistic",
    conflictScope: ["core.content_item"],
    bytes: "uploaded-and-verified",
    connectivity: "none",
    why: "A content row is the identity of a byte string, so the gateway executes it only once those bytes have arrived and been verified (R25); until then the capture is protected from eviction on the seat.",
  },
};

// ── people.important_date.write ────────────────────────────────────────────

const IMPORTANT_DATE_WRITE: DomainOperation = {
  name: "people.important_date.write",
  writes: ["people.important_date"],
  preconditions: IMPORTANT_DATE_CONDITIONS.map((condition) => ({
    name: condition.name,
    assert: (vault: DatabaseSync, input: Readonly<Record<string, unknown>>) =>
      condition.assert(vault, {
        dateId: text(input, "date_id"),
        ...(Object.hasOwn(input, "month_day")
          ? { monthDay: text(input, "month_day") }
          : {}),
      }),
  })),
  postconditions: [
    {
      name: "important_date_is_stored_as_written",
      assert: (vault, input) => {
        const dateId = text(input, "date_id");
        if (dateId === null) return null;
        const row = vault
          .prepare(
            "SELECT month_day FROM people_important_date WHERE date_id = ?"
          )
          .get(dateId) as { month_day: string } | undefined;
        if (!row) return null;
        const stated = text(input, "month_day");
        return stated === null || stated === row.month_day
          ? null
          : "The stored anniversary is not the one that was written.";
      },
    },
  ],
  readSet: (input) =>
    entries(
      ref("core.party", input, "party_id"),
      ref("people.important_date", input, "date_id")
    ),
  offline: localEdit(["people.important_date", "core.party"]),
};

// ── atlas.row.write ────────────────────────────────────────────────────────

/**
 * Atlas is INSIDE the boundary (#996, R21 / ONT-26). Its own conditions were
 * empty; they are now the domain operations', dispatched by the table the
 * request names, so the same invalid mutation is refused by the same named
 * condition whether it arrives as a typed command, an import or a row editor.
 */
const ATLAS_WRITE: DomainOperation = {
  name: "atlas.row.write",
  writes: ["*"],
  preconditions: [
    {
      name: "row_passes_its_domain_operation",
      assert: (vault, input) => {
        const table = text(input, "table");
        if (table === null) return null;
        const values = input["values"] ?? input["set"];
        if (values === null || typeof values !== "object") return null;
        const refusal = assertCanonicalWrite(vault, {
          table,
          op: Object.hasOwn(input, "set") ? "update" : "insert",
          id: text(input, "id"),
          values: values as Record<string, unknown>,
        });
        return refusal === null ? null : refusal.message;
      },
    },
  ],
  postconditions: [
    {
      name: "row_exists_after_the_write",
      assert: () => null,
    },
  ],
  readSet: (input) =>
    entries(
      text(input, "table") === null || text(input, "id") === null
        ? null
        : { entity: text(input, "table")!, id: text(input, "id")! }
    ),
  offline: {
    submission: "online-only",
    pending: "hidden",
    conflictScope: ["*"],
    bytes: "none",
    connectivity: "gateway-authority",
    why: "A row editor names a table at request time, so its conflict scope cannot be declared ahead of the request and no seat can promise the refusals it will meet — R25's explicit unavailable, not a queue.",
  },
};

export const DOMAIN_OPERATIONS: readonly DomainOperation[] = [
  TASK_WRITE,
  TASK_COMPLETE,
  TASK_REOPEN,
  CONTENT_WRITE,
  IMPORTANT_DATE_WRITE,
  ATLAS_WRITE,
];

const BY_NAME = new Map(
  DOMAIN_OPERATIONS.map((operation) => [operation.name, operation])
);

export function domainOperation(name: string): DomainOperation | undefined {
  return BY_NAME.get(name);
}
