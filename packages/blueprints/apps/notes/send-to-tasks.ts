// Send to Tasks (#834): parsing only; the write is the action handler.

import { MONTHS as MONTHS_PRINTED } from "../_shared/format-kit.ts";
import { sentToTasks } from "./view-copy.ts";

const ISO = /\b(?<iso>\d{4}-\d{2}-\d{2})\b/u;
const RELATIVE = /\b(?<word>today|tonight|tomorrow)\b/iu;
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
// Alternation DERIVED from the printed list (#883 B4): a second hand-kept copy
// is a second chance to misspell a month.
const MONTHS = MONTHS_PRINTED.map((month) => month.toLowerCase());
const WEEKDAY_RE = new RegExp(`\\b(?<day>${WEEKDAYS.join("|")})\\b`, "iu");
const MONTH_DAY_RE = new RegExp(
  `\\b(?<day>\\d{1,2})\\s+(?<month>${MONTHS.join("|")})\\b|` +
    `\\b(?<month2>${MONTHS.join("|")})\\s+(?<day2>\\d{1,2})\\b`,
  "iu"
);
const WIKILINK = /\[\[(?<target>[^\]]+)\]\]/u;

function dayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function shift(from: Date, days: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
}

/** Date-only: an invented moment lands a reminder at midnight. Weekdays
 *  resolve FORWARD — "Friday" on a Friday means today. */
export function dateFromLine(text: string, now: Date): string | null {
  const iso = ISO.exec(text)?.groups?.["iso"];
  if (iso) return iso;

  const relative = RELATIVE.exec(text)?.groups?.["word"]?.toLowerCase();
  if (relative) return dayKey(shift(now, relative === "tomorrow" ? 1 : 0));

  const weekday = WEEKDAY_RE.exec(text)?.groups?.["day"]?.toLowerCase();
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday);
    const ahead = (target - now.getDay() + 7) % 7;
    return dayKey(shift(now, ahead));
  }

  const monthDay = MONTH_DAY_RE.exec(text)?.groups;
  if (monthDay) {
    const month = MONTHS.indexOf(
      (monthDay["month"] ?? monthDay["month2"] ?? "").toLowerCase()
    );
    const day = Number(monthDay["day"] ?? monthDay["day2"]);
    if (month >= 0 && day >= 1 && day <= 31) {
      const thisYear = new Date(now.getFullYear(), month, day);
      // A month already behind means next year.
      const year =
        dayKey(thisYear) < dayKey(now)
          ? now.getFullYear() + 1
          : now.getFullYear();
      return dayKey(new Date(year, month, day));
    }
  }
  return null;
}

/** Two cases earn the control: a line naming a day, or one on `[[…]]`. */
export function wantsDate(line: { text: string; checked: boolean }): boolean {
  if (line.checked) return false;
  const text = line.text.trim();
  if (text === "") return false;
  return dateFromLine(text, new Date()) !== null || WIKILINK.test(text);
}

export interface SendToTasksPayload {
  title: string;
  /** Absent unless the line carried one; undated never touches Today. */
  due_at?: string;
  note_id: string;
  line: number;
  exact: string;
}

export function sendToTasksPayload(input: {
  noteId: string;
  line: number;
  text: string;
  now?: Date;
}): SendToTasksPayload {
  const exact = input.text.trim();
  const title = exact
    .replace(/\[\[(?<target>[^\]]+)\]\]/gu, (_match, target: string) => target)
    .replace(/\s+/gu, " ")
    .trim();
  const due = dateFromLine(exact, input.now ?? new Date());
  return {
    title,
    ...(due ? { due_at: due } : {}),
    note_id: input.noteId,
    line: input.line,
    exact,
  };
}

type Write = (
  action: string,
  input: Record<string, unknown>
) => Promise<{ status?: string } | undefined>;

export async function sendLineToTasks(
  write: Write,
  status: (text: string) => void,
  line: { noteId: string; line: number; text: string }
): Promise<void> {
  const payload = sendToTasksPayload(line);
  const outcome = await write("send-to-tasks", {
    title: payload.title,
    ...(payload.due_at ? { due_at: payload.due_at } : {}),
    note_id: payload.note_id,
    exact: payload.exact,
  });
  if (outcome?.status === "executed") status(sentToTasks(payload.title));
}
