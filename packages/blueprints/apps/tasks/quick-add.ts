import { DAY_MS } from "../_shared/format-kit.ts";
import { GROUPS, landsInFoot } from "./view-copy.ts";
import type { QUICK_ADD_WHEN } from "./view-copy.ts";
import { dayKey } from "./when.ts";

export type QuickAddWhenKey = (typeof QUICK_ADD_WHEN)[number]["key"];

export interface QuickAddDraft {
  title: string;
  when: QuickAddWhenKey;
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

export function quickAddReady(draft: QuickAddDraft): boolean {
  return draft.title.trim().length > 0;
}

export function quickAddInput(
  draft: QuickAddDraft,
  now: string
): Record<string, string | number> {
  const due = quickAddDue(draft.when, now);
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
