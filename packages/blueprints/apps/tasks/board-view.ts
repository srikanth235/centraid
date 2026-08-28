// The board's toolbar (spec §4). MINE AND HOUSE ARE ONE AXIS: a row is
// personal or it carries a scope, never both, so holding both lenses would
// filter the board to nothing — `toggleLens` retires the sibling instead.
import { priorityLevel } from "./format.ts";
import { byDueDay } from "./logic.ts";
import { tasksScopeDeclaration } from "./scope-declaration.ts";
import type { Task, TaskGroup } from "./types.ts";
import { DENIED } from "./view-copy.ts";
import type { LENSES, SORT_LABELS } from "./view-copy.ts";

export type TasksLensKey = (typeof LENSES)[number]["key"];
export type TasksSortKey = keyof typeof SORT_LABELS;

export const EFFORT_LENS_MAX = 30;

const AUDIENCE: readonly TasksLensKey[] = ["mine", "house"];

export function lensHolds(key: TasksLensKey, task: Task): boolean {
  if (key === "effort") {
    const effort = task.effort_min ?? 0;
    return effort > 0 && effort <= EFFORT_LENS_MAX;
  }
  return key === "house" ? Boolean(task.scope_id) : !task.scope_id;
}

/** The set is an AND, so the count only falls. */
export function lensedRows(
  rows: readonly Task[],
  lenses: readonly TasksLensKey[]
): Task[] {
  return rows.filter((task) => lenses.every((key) => lensHolds(key, task)));
}

export function toggleLens(
  active: readonly TasksLensKey[],
  key: TasksLensKey
): TasksLensKey[] {
  if (active.includes(key)) return active.filter((entry) => entry !== key);
  const kept = AUDIENCE.includes(key)
    ? active.filter((entry) => !AUDIENCE.includes(entry))
    : [...active];
  return [...kept, key];
}

export function byPriorityWithinDate(a: Task, b: Task): number {
  const due = byDueDay(a, b);
  if (due !== 0) return due;
  const left = priorityLevel(a.priority);
  const right = priorityLevel(b.priority);
  if (left !== right) return right - left;
  return a.title.localeCompare(b.title);
}

/** The member's own `sort_order`, never re-derived from the dates. */
export function byManualOrder(a: Task, b: Task): number {
  const left = a.sort_order ?? 0;
  const right = b.sort_order ?? 0;
  if (left !== right) return left - right;
  return a.title.localeCompare(b.title);
}

export function sortGroups(
  groups: readonly TaskGroup[],
  sort: TasksSortKey
): TaskGroup[] {
  const compare = sort === "manual" ? byManualOrder : byPriorityWithinDate;
  return groups.map((group) => ({
    ...group,
    rows: [...group.rows].sort(compare),
  }));
}

export function nextSort(sort: TasksSortKey): TasksSortKey {
  return sort === "manual" ? "priority" : "manual";
}

export interface DeniedFact {
  key: "receipt" | "scope" | "when";
  label: string;
  value: string;
}

export const TASKS_SCOPE = tasksScopeDeclaration.mintedIdFamilies.join(" · ");

/** No row for a fact the seat lacks: an em dash beside "Receipt" is a
 *  placeholder wearing a fact's clothes. */
export function deniedFacts(input: {
  receipt?: string | null;
  scope?: string | null;
  when?: string | null;
}): DeniedFact[] {
  const rows: DeniedFact[] = [];
  if (input.receipt)
    rows.push({ key: "receipt", label: DENIED.receipt, value: input.receipt });
  if (input.scope)
    rows.push({ key: "scope", label: DENIED.scope, value: input.scope });
  if (input.when)
    rows.push({ key: "when", label: DENIED.when, value: input.when });
  return rows;
}
