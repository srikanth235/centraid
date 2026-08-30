// `.js` specifier: the client program typechecks this module and does not
// enable `allowImportingTsExtensions`. A package import of format-kit also
// failed Rolldown in the gateway image, which copies sources and not dist.
import { DAY_MS, MONTHS } from "../_shared/format-kit.js";

/** WHEN a task is (#834). Import-free so Home and the phone can read it;
 *  `format.ts`/`logic.ts` re-export — one definition of `landsToday`. */

/**
 * Local YYYY-MM-DD in `timeZone` (IANA), or the host zone. Intl, not
 * `Date#getFullYear` with a post-boot `process.env.TZ` write: Node ignores TZ
 * after boot, so that goes green on a Mac and red on UTC CI.
 */
function civilDay(instant: Date, timeZone?: string): string | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/** A civil day key (`2026-08-21`). Instants use the member's local calendar
 *  day — never the UTC prefix. */
export function dayKey(value: string, timeZone?: string): string {
  if (isDateOnly(value)) return value.slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return civilDay(parsed, timeZone) ?? value.slice(0, 10);
}

export function isDateOnly(due: string | null | undefined): boolean {
  return typeof due === "string" && !due.includes("T");
}

/** Whole civil days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(
  from: string,
  to: string,
  timeZone?: string
): number {
  const a = Date.parse(`${dayKey(from, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(to, timeZone)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function weekdayName(value: string): string {
  const parsed = new Date(`${dayKey(value)}T00:00:00Z`);
  return WEEKDAYS[parsed.getUTCDay()] ?? "";
}

export function monthName(value: string): string {
  const index = Number(value.slice(5, 7)) - 1;
  return MONTHS[index] ?? "";
}

export function timeOfDay(value: string): string {
  return value.slice(11, 16);
}

export function dueLabel(
  due: string | null | undefined,
  now: string,
  timeZone?: string
): string | null {
  if (!due) return null;
  const delta = daysBetween(now, due, timeZone);
  const clock = isDateOnly(due) ? "" : `, ${timeOfDay(due)}`;
  if (delta === 0) return `today${clock}`;
  if (delta === 1) return `tomorrow${clock}`;
  if (delta === -1) return `yesterday${clock}`;
  if (delta < 0) return `${Math.abs(delta)} days ago`;
  if (delta <= 6) return `${weekdayName(due)}${clock}`;
  return `${Number(due.slice(8, 10))} ${monthName(due).slice(0, 3)}${clock}`;
}

export interface TaskWhen {
  due_at?: string | null;
  next_due?: string | null;
}

export function landsToday(task: TaskWhen, now: string): boolean {
  const due = task.next_due ?? task.due_at;
  if (!due) return false;
  return daysBetween(now, due) <= 0;
}

export function isOverdueWhen(task: TaskWhen, now: string): boolean {
  const due = task.next_due ?? task.due_at;
  if (!due) return false;
  return daysBetween(now, due) < 0;
}

/** VTODO open set — the statuses the live board may act on. */
export function isOpenStatus(status: string): boolean {
  return status === "needs-action" || status === "in-process";
}

export interface FamilyRow {
  task_id: string;
  parent_task_id?: string | null;
  status: string;
}

/** An unfinished child of a completed or released parent is a root of its own
 *  — completing the parent must not hide remaining work. */
export function isOpenBoardRoot(
  task: FamilyRow,
  parent: FamilyRow | undefined
): boolean {
  if (!isOpenStatus(task.status)) return false;
  if (!task.parent_task_id) return true;
  return !parent || !isOpenStatus(parent.status);
}

/** Unfinished children of a closed parent are promoted onto the open board;
 *  the logbook parent keeps only closed children, so no row is drawn twice. */
export function nestTaskFamilies<T extends FamilyRow>(
  rows: readonly T[],
  decorate: (task: T, children: T[]) => T
): { open: T[]; logbook: T[] } {
  const byId = new Map(rows.map((row) => [row.task_id, row]));
  const childrenOf = new Map<string, T[]>();
  for (const row of rows) {
    const parentId = row.parent_task_id;
    if (!parentId) continue;
    const list = childrenOf.get(parentId);
    if (list) list.push(row);
    else childrenOf.set(parentId, [row]);
  }

  const open: T[] = [];
  const logbook: T[] = [];
  for (const row of rows) {
    const parent = row.parent_task_id
      ? byId.get(row.parent_task_id)
      : undefined;
    if (isOpenBoardRoot(row, parent)) {
      open.push(decorate(row, childrenOf.get(row.task_id) ?? []));
      continue;
    }
    if (row.parent_task_id || isOpenStatus(row.status)) continue;
    const nested = (childrenOf.get(row.task_id) ?? []).filter(
      (child) => !isOpenStatus(child.status)
    );
    logbook.push(decorate(row, nested));
  }
  return { open, logbook };
}
