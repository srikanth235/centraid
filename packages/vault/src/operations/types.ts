// ONE INVARIANT BOUNDARY (#996, ruling R21, drift ONT-26).
//
// Before this module, a domain command, an importer and Atlas each enforced a
// different subset of the model. `people.add_important_date` refused February
// 31 in its input schema; `atlas.insert_row` wrote it. `schedule.add_task`
// checked a parent was open and top-level; Atlas accepted a task as its own
// parent. Nothing anywhere refused `due_at: "banana"`.
//
// A domain operation is the answer to "what does it MEAN to write this row",
// stated once and reached by every writer. Its parts:
//
//   preconditions   what must be true of the vault and the proposed row image
//                   BEFORE the write. Non-empty for every operation — an empty
//                   set is the defect ONT-26 named.
//   postconditions  what must be true after, checked inside the invocation
//                   transaction so a failure rolls the write back.
//   readSet         the rows the operation READ to decide (R6/R23): the set an
//                   offline intent must reference by version, and the set the
//                   gateway's conflict check compares. A base-version set
//                   short of this is refused rather than executed on a guess.
//   offline         R25's declaration, as data: whether the operation may be
//                   submitted offline, what a seat shows while it is pending,
//                   the scope a conflict is judged over, and the byte or
//                   connectivity prerequisites. Apps invent none of this.
//
// A condition returns `null` when it holds and an owner-facing SENTENCE when
// it does not, because the sentence is what a member reads and what the
// writer-matrix test compares across writers: the same invalid mutation
// through a command, an import and Atlas must be refused by the same named
// condition with the same words.

import type { DatabaseSync } from "node:sqlite";

/** A row the operation must observe to decide — the R6 declared read-set. */
export interface ReadSetEntry {
  /** Logical entity name, e.g. `schedule.task`. */
  readonly entity: string;
  /** The row's primary key, or `null` for "every row of this entity the
   *  operation's filter selects" (a set the seat cannot version-reference, so
   *  the operation carrying one is not offline-submittable). */
  readonly id: string | null;
}

/** R25's declaration, beside the operation rather than in an app. */
export interface OfflineDeclaration {
  /** Whether a seat may queue this operation while disconnected. */
  readonly submission: "offline" | "online-only";
  /** What the seat shows for the operation between submit and settle. */
  readonly pending: "optimistic" | "hidden";
  /** The entities a conflict is judged over — the read-set's entity names. */
  readonly conflictScope: readonly string[];
  /** Bytes the gateway must hold, verified, before the operation executes. */
  readonly bytes: "none" | "uploaded-and-verified";
  /** Authority the operation needs from the gateway at execution time. */
  readonly connectivity: "none" | "gateway-authority";
  /** Why this shape and not another — read by a reviewer, not by code. */
  readonly why: string;
}

export interface OperationCondition {
  /** Stable name; it is what the receipt and the writer matrix compare. */
  readonly name: string;
  /**
   * Holds → `null`. Fails → the owner-facing sentence. The input is the
   * command's, normalised by the operation's own reader, so one condition
   * serves `schedule.add_task`, an import and `atlas.insert_row` alike.
   */
  readonly assert: (
    vault: DatabaseSync,
    input: Readonly<Record<string, unknown>>
  ) => string | null;
}

export interface DomainOperation {
  /** `<entity>.<verb>`, e.g. `schedule.task.write`. */
  readonly name: string;
  /** Logical entities the operation may write. */
  readonly writes: readonly string[];
  readonly preconditions: readonly OperationCondition[];
  readonly postconditions: readonly OperationCondition[];
  readonly readSet: (
    input: Readonly<Record<string, unknown>>
  ) => readonly ReadSetEntry[];
  readonly offline: OfflineDeclaration;
}

/** Thrown by an operation whose precondition a direct caller violated — the
 *  import path, which does not run the gateway's contract stage. */
export class OperationRefusalError extends Error {
  constructor(
    readonly operation: string,
    readonly condition: string,
    message: string
  ) {
    super(message);
    this.name = "OperationRefusalError";
  }
}
