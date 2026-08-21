// Send to Tasks — the release valve for checklist necrosis (#834).
//
// A checklist line that wants a date stops being note content and becomes a
// real task. ONE TO-DO SYSTEM IN THE HOUSE: what leaves here is a
// `schedule.add_task` row on the same spine Tasks reads, linked back to the
// note it came from, and Notes stores nothing about it afterwards. There is
// deliberately no "sent" flag on the line — a second store of task-ness in
// this app is the defect this whole slice exists to prevent.
//
// Pure and DOM-free: which lines offer the control, and what the resulting
// task carries, are facts about the line's text plus the clock — so both are
// functions here rather than branches in a render.

import { sentToTasks } from "./view-copy.ts";

/** The date cues a line can carry, in the order they are tried. */
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
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAY_RE = new RegExp(`\\b(?<day>${WEEKDAYS.join("|")})\\b`, "iu");
const MONTH_DAY_RE = new RegExp(
  `\\b(?<day>\\d{1,2})\\s+(?<month>${MONTHS.join("|")})\\b|` +
    `\\b(?<month2>${MONTHS.join("|")})\\s+(?<day2>\\d{1,2})\\b`,
  "iu"
);
/** A `[[wikilink]]` — the line names someone or something else in the house. */
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

/**
 * The date a line carries, as a DATE-ONLY due value, or null.
 *
 * Date-only on purpose: a note line says "Friday", not "Friday at 17:00", and
 * inventing a moment would put a reminder at midnight — the midnight problem
 * Tasks' own `format.ts` is built to avoid. A weekday resolves FORWARD, and
 * "this Friday" on a Friday means today rather than a week away.
 */
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
      // A month already behind us means next year: a note written in December
      // saying "3 January" is not asking for a date eleven months past.
      const year =
        dayKey(thisYear) < dayKey(now)
          ? now.getFullYear() + 1
          : now.getFullYear();
      return dayKey(new Date(year, month, day));
    }
  }
  return null;
}

/**
 * Does this line WANT a date?
 *
 * The control appears here and nowhere else, because a control on every line
 * would make "send to Tasks" the way a checklist is used rather than the way
 * it is escaped. Two cases earn it, and both are things a checklist handles
 * badly:
 *
 *  1. The line already names a day. A dated commitment sitting inside prose is
 *     invisible on the day it comes due — that is the whole argument.
 *  2. The line depends on someone or something else (`[[…]]`). A line that
 *     waits on another person is the one that rots, and the task spine is
 *     where a waiting commitment can actually be seen.
 *
 * A line already ticked off is finished, and a blank one is not a commitment;
 * neither offers anything.
 */
export function wantsDate(line: { text: string; checked: boolean }): boolean {
  if (line.checked) return false;
  const text = line.text.trim();
  if (text === "") return false;
  return dateFromLine(text, new Date()) !== null || WIKILINK.test(text);
}

/** What Notes hands to `schedule.add_task`, plus the link back to the note. */
export interface SendToTasksPayload {
  title: string;
  /** Absent unless the line actually carried a date — an undated task never
   *  touches Today and never reaches the calendar grid. */
  due_at?: string;
  note_id: string;
  /** The line the task came from, so the link's anchor points at the exact
   *  passage rather than at the note as a whole. */
  line: number;
  exact: string;
}

/**
 * The payload for one line. The title is the line's own words with the
 * `[[…]]` sigils removed — a task title is a sentence a member reads, not
 * markup — and the date rides along only when the line carried one.
 */
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

/** The narrow slice of the orchestrator's write path this needs. */
type Write = (
  action: string,
  input: Record<string, unknown>
) => Promise<{ status?: string } | undefined>;

/**
 * Hand one checklist line to Tasks.
 *
 * ONE TO-DO SYSTEM IN THE HOUSE: the action mints a canonical `schedule.task`
 * row and links it back to the note; nothing about the line changes and
 * nothing about the task is stored on this side. The frame's one status line
 * says where it went, so the gesture reads as a handover rather than a
 * disappearance.
 */
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
