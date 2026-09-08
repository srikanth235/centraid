// The domain operation layer (#996, wave 0c; rulings R21, R23, R25).
//
// One invariant boundary: every writer — typed command, importer, Atlas and in
// W9 the seat's local apply — reaches a canonical table through the operations
// declared here, so the same invalid mutation meets the same named condition
// with the same words whichever door it arrives at.

import type { OperationConditionSpec } from "../gateway/types.js";
import { domainOperation } from "./registry.js";
import { TASK_WRITE_CONDITIONS, taskImage } from "./task-write.js";
import type { TaskWriteDraft } from "./task-write.js";
import type { ReadSetEntry } from "./types.js";

export {
  assertCanonicalWrite,
  OPERATION_OF_TABLE,
  type CanonicalRefusal,
  type CanonicalWrite,
} from "./canonical-write.js";
export { domainOperation, DOMAIN_OPERATIONS } from "./registry.js";
export {
  cancelTask,
  completeTask,
  reopenTask,
  SUCCESSOR_INHERITS_SERIES_LINKS_SQL,
} from "./task-lifecycle.js";
export { type TaskWriteDraft } from "./task-write.js";
export {
  OperationRefusalError,
  type DomainOperation,
  type OfflineDeclaration,
  type ReadSetEntry,
} from "./types.js";

/**
 * A command's share of an operation's conditions, ready to splice into its
 * `preconditions` / `postconditions`. The command keeps its own SQL specs
 * beside them — what is shared is the MODEL, not the command's own contract.
 */
export function operationConditions(
  operation: string,
  stage: "pre" | "post"
): OperationConditionSpec[] {
  const found = domainOperation(operation);
  if (!found) throw new Error(`unknown domain operation ${operation}`);
  const conditions =
    stage === "pre" ? found.preconditions : found.postconditions;
  return conditions.map((condition) => ({
    name: condition.name,
    operation: found.name,
    assert: condition.assert,
  }));
}

/**
 * `schedule.task.write`'s conditions, over a draft this command reads from its
 * own input. Every task writer differs in vocabulary — `clear_project` here, a
 * bare column there, a values object in Atlas — and agrees on the model, which
 * is the whole point of the boundary: the reader is the command's, the
 * conditions are everyone's.
 */
export function taskWriteConditions(
  read: (input: Readonly<Record<string, unknown>>) => TaskWriteDraft
): OperationConditionSpec[] {
  return TASK_WRITE_CONDITIONS.map((condition) => ({
    name: condition.name,
    operation: "schedule.task.write",
    assert: (vault, input) =>
      condition.assert(vault, taskImage(vault, read(input))),
  }));
}

/**
 * The rows an operation READ to decide, for the input it was given (R6/R23).
 * The intent conflict checker refuses a base-version set short of this: an
 * offline intent that never observed a row the operation consults would settle
 * against a version nobody looked at.
 */
export function operationReadSet(
  operation: string,
  input: Readonly<Record<string, unknown>>
): readonly ReadSetEntry[] {
  return domainOperation(operation)?.readSet(input) ?? [];
}
