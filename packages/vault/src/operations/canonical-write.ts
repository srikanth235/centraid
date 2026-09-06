// THE BOUNDARY ITSELF (#996, ruling R21; drift ONT-26).
//
// A canonical table is reached by naming a table and a set of columns —
// `atlas.insert_row`, `atlas.update_row`, an importer's publisher, and in W9
// the seat's local apply. Each of those hands its proposed row image here, and
// here it meets the same domain operation a typed command meets.
//
// The dispatch is by LOGICAL TABLE, so adding an operation covers every writer
// at once; a table with no semantic operation falls through with `null` and is
// still held by its CHECKs, its partial indexes and its triggers — the simple
// invariants R21 says belong in the schema rather than in code.

import type { DatabaseSync } from "node:sqlite";

import { assertContentWrite } from "./content-write.js";
import { assertImportantDateWrite } from "./important-date-write.js";
import { assertTaskWrite } from "./task-write.js";

export type CanonicalWriteOp = "insert" | "update";

export interface CanonicalWrite {
  /** Logical entity name, e.g. `schedule.task`. */
  readonly table: string;
  readonly op: CanonicalWriteOp;
  /** The row's key — `null` when an insert has not minted one yet. */
  readonly id: string | null;
  /** The columns this write STATES. A column absent here is unchanged. */
  readonly values: Readonly<Record<string, unknown>>;
}

export interface CanonicalRefusal {
  readonly operation: string;
  readonly condition: string;
  readonly message: string;
}

/** `undefined` when the column is not stated; the value otherwise. */
function stated(
  values: Readonly<Record<string, unknown>>,
  column: string
): unknown {
  return Object.hasOwn(values, column) ? values[column] : undefined;
}

function statedText(
  values: Readonly<Record<string, unknown>>,
  column: string
): string | null | undefined {
  const value = stated(values, column);
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return String(value);
}

function statedNumber(
  values: Readonly<Record<string, unknown>>,
  column: string
): number | null | undefined {
  const value = stated(values, column);
  if (value === undefined) return undefined;
  if (value === null) return null;
  return Number(value);
}

/** Which operation owns a table's semantics, for the receipt and the matrix. */
export const OPERATION_OF_TABLE: Readonly<Record<string, string>> = {
  "schedule.task": "schedule.task.write",
  "core.content_item": "core.content_item.write",
  "people.important_date": "people.important_date.write",
};

/**
 * Run the domain operation that owns `write.table` against the proposed row
 * image. `null` passes.
 */
export function assertCanonicalWrite(
  vault: DatabaseSync,
  write: CanonicalWrite
): CanonicalRefusal | null {
  const operation = OPERATION_OF_TABLE[write.table];
  if (operation === undefined) return null;
  const id = write.op === "insert" ? null : write.id;
  switch (write.table) {
    case "schedule.task": {
      const failed = assertTaskWrite(vault, {
        taskId: id,
        parentTaskId: statedText(write.values, "parent_task_id"),
        projectId: statedText(write.values, "project_id"),
        sectionId: statedText(write.values, "section_id"),
        dueAt: statedText(write.values, "due_at"),
        rrule: statedText(write.values, "rrule"),
        status: statedText(write.values, "status"),
      });
      // An insert states its own key, so a row claiming itself as parent is
      // caught before it exists rather than after.
      if (failed === null && write.op === "insert") {
        const own = statedText(write.values, "task_id");
        const parent = statedText(write.values, "parent_task_id");
        if (own !== null && own !== undefined && own === parent) {
          return {
            operation,
            condition: "task_hierarchy_is_acyclic",
            message: "A task cannot be its own parent.",
          };
        }
      }
      return failed === null ? null : { operation, ...failed };
    }
    case "core.content_item": {
      const failed = assertContentWrite(vault, {
        contentId: id,
        sha256: statedText(write.values, "sha256"),
        contentUri: statedText(write.values, "content_uri"),
        byteSize: statedNumber(write.values, "byte_size"),
      });
      return failed === null ? null : { operation, ...failed };
    }
    case "people.important_date": {
      const failed = assertImportantDateWrite(vault, {
        dateId: id,
        monthDay: statedText(write.values, "month_day"),
      });
      return failed === null ? null : { operation, ...failed };
    }
    default:
      return null;
  }
}
