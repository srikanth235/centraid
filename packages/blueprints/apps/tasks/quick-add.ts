import { DAY_MS } from "../_shared/format-kit.ts";
// Quick add, projected (spec §3). THE FIELD NEVER PARSES A SENTENCE: the
// chips carry When/Where/Priority and `QUICK_ADD.assistant` is the door for
// words. `add_task` takes no project, so filing is a SECOND write.
import type { ShelfId } from "./shelves.ts";
import { GROUPS, landsInFoot } from "./view-copy.ts";
import type { QUICK_ADD_WHEN } from "./view-copy.ts";
import { dayKey } from "./when.ts";

export type QuickAddWhenKey = (typeof QUICK_ADD_WHEN)[number]["key"];

export interface QuickAddDraft {
  title: string;
  when: QuickAddWhenKey;
  /** `null` is the Inbox — the absence of a project, not one named for it. */
  projectId: string | null;
  priority: number;
  scopeId: string | null;
}

export const QUICK_ADD_EMPTY: QuickAddDraft = {
  title: "",
  when: "none",
  projectId: null,
  priority: 0,
  scopeId: null,
};

function shiftDay(day: string, days: number): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) return day;
  return new Date(at + days * DAY_MS).toISOString().slice(0, 10);
}

function weekday(day: string): number {
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getUTCDay();
}

/** A weekend that has arrived is today, never next week's. */
export function quickAddDue(when: QuickAddWhenKey, now: string): string | null {
  const today = dayKey(now);
  if (when === "none") return null;
  if (when === "today") return today;
  if (when === "tomorrow") return shiftDay(today, 1);
  const day = weekday(today);
  if (when === "weekend") {
    return day === 0 || day === 6 ? today : shiftDay(today, 6 - day);
  }
  return shiftDay(today, day === 0 ? 1 : 8 - day);
}

/**
 * THE SHELF IS PART OF THE CAPTURE (#996, W4-D3).
 *
 * A shelf is a FILTER, and an item created inside a filter belongs to it: a
 * task captured on Today is due today, even when the member touched no When
 * chip, because the alternative is a save that lands somewhere the member is
 * not looking. Every other shelf contributes no date — an undated task is an
 * INBOX task (`inboxGroup`: open, unfiled), and `todayGroups` never draws one.
 *
 * `null` is the Today shelf's id (`TASK_SHELVES`); `undefined` is a capture
 * that came from no board at all, which is why the two cannot be one value.
 */
export function shelfDue(
  shelf: ShelfId | undefined,
  now: string
): string | null {
  return shelf === null ? dayKey(now) : null;
}

export function quickAddReady(draft: QuickAddDraft): boolean {
  return draft.title.trim().length > 0;
}

/**
 * The write `add_task` takes. The When chip wins when the member set one; the
 * shelf answers when they did not (W4-D3).
 */
export function quickAddInput(
  draft: QuickAddDraft,
  now: string,
  shelf?: ShelfId
): Record<string, string | number> {
  const due = quickAddDue(draft.when, now) ?? shelfDue(shelf, now);
  return {
    title: draft.title.trim(),
    ...(due ? { due_at: due } : {}),
    ...(draft.priority > 0 ? { priority: draft.priority } : {}),
  };
}

export function quickAddFiling(
  draft: QuickAddDraft,
  taskId: string
): Record<string, string | number> | null {
  return draft.projectId
    ? { task_id: taskId, sort_order: 0, project_id: draft.projectId }
    : null;
}

export function quickAddLandsIn(input: {
  projectName?: string | null;
  vault: string;
}): string {
  return landsInFoot(input.projectName ?? GROUPS.inbox, input.vault);
}
