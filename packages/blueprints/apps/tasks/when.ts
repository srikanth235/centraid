/**
 * WHEN a task is (#834). Import-free so Home and the phone can both read it.
 * `format.ts` and `logic.ts` re-export from here — one definition of
 * `landsToday`. An undated task never touches Today.
 */

/**
 * Local YYYY-MM-DD for an instant in `timeZone` (IANA), or the host zone when
 * omitted. Intl, not `Date#getFullYear` plus a post-start `process.env.TZ`
 * write: Node ignores TZ after boot, which is how "Today is the member's day"
 * went green on a Mac and red on UTC CI.
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

/** A civil day key (`2026-08-21`) for an ISO instant or a date-only value.
 *  Instants use the member's local calendar day — never the UTC prefix. */
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
  return Math.round((b - a) / 86_400_000);
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
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
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

/** VTODO open set — the only statuses the live board may still act on. */
export function isOpenStatus(status: string): boolean {
  return status === "needs-action" || status === "in-process";
}

/** The fields family nesting reads off a board row. */
export interface FamilyRow {
  task_id: string;
  parent_task_id?: string | null;
  status: string;
}

/**
 * Does this row belong on the OPEN board as a family root? An unfinished
 * child of a completed or released parent is a root of its own — completing
 * the parent must not hide remaining work.
 */
export function isOpenBoardRoot(
  task: FamilyRow,
  parent: FamilyRow | undefined
): boolean {
  if (!isOpenStatus(task.status)) return false;
  if (!task.parent_task_id) return true;
  return !parent || !isOpenStatus(parent.status);
}

/**
 * Split a flat task list into the open board and the logbook. Unfinished
 * children of a closed parent are promoted onto the open board; the logbook
 * parent keeps only closed children, so the same row is never drawn twice.
 */
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
