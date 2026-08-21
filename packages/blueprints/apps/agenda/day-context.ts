// The day-context layers, as pure derivations over the `day-context` payload
// (#834 R-daycontext).
//
// THE GRID IS FOR THINGS WITH A TIME COST. Everything date-shaped and costless
// — a birthday, a task coming due, a subscribed holiday — is stored once where
// it belongs and projected onto a day as a RIBBON or a SHELF. No event row is
// ever created for one, which is why nothing in this module returns anything
// shaped like an event.
//
// Pure and DOM-free on purpose: keying by day, the collapse counts and the
// layer-off rule are facts about the payload plus the member's switches, so
// each is a function here rather than a branch inside a grid cell. A second
// answer to "does this day have a birthday" living in Month and another in Day
// is exactly the drift this file exists to prevent.
import {
  ribbonCollapsed,
  ribbonCollapsedBirthdays,
  shelfDue,
} from "./view-copy.ts";

/** The three layers, in the order the rail draws them. */
export type LayerId = "bdays" | "due" | "hols";

/** Which layers the member has switched on. */
export type LayerState = Readonly<Record<LayerId, boolean>>;

export const ALL_LAYERS_ON: LayerState = { bdays: true, due: true, hols: true };

/** A birthday the vault could answer, with the closeness tier it carries. */
export interface BirthdayFact {
  party_id: string;
  name: string;
  /** 1–12. Birthdays recur annually, so the fact carries no year. */
  month: number;
  day: number;
  tier: "inner" | "outer";
}

/** One of the member's own open tasks, as far as a shelf reads it. Agenda
 *  never edits a task; the row exists so the tap-through knows which one to
 *  hand to Tasks. */
export interface DueTask {
  task_id: string;
  title: string;
}

export interface DueFact {
  /** `YYYY-MM-DD`. */
  day: string;
  /** The true count for the day, which may exceed `tasks.length`. */
  count: number;
  /** The first few rows, bounded by the query — a shelf lists, it does not
   *  page. */
  tasks?: readonly DueTask[];
}

export interface HolidayFact {
  day: string;
  name: string;
}

/** The `day-context` payload. A denial rides `vaultDenied` — a first-class
 *  outcome, never an error, and it degrades to NO layers rather than a broken
 *  rail. */
export interface DayContextData {
  birthdays: readonly BirthdayFact[];
  due: readonly DueFact[];
  holidays: readonly HolidayFact[];
  vaultDenied?: { code?: string; message?: string };
}

/** What a read that has not landed (or was refused) decorates: nothing. */
export const NO_DAY_CONTEXT: DayContextData = {
  birthdays: [],
  due: [],
  holidays: [],
};

/** One costless fact about a day, as the ribbon draws it. */
export interface RibbonFact {
  kind: "birthday" | "holiday";
  /** Stable within a day — the key a list render needs. */
  id: string;
  text: string;
  /** Only a starred person is `inner`; it is the one tier the vault stores. */
  inner?: boolean;
}

/** The `MM-DD` half of a day key, which is what an annual birthday matches. */
function monthDayOf(dayKey: string): string {
  return dayKey.slice(5, 10);
}

function padded(month: number, day: number): string {
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The ribbon facts for one day, in the rail's own layer order.
 *
 * SWITCHING A LAYER OFF REMOVES ITS FACTS AND NOTHING ELSE — the reason the
 * filter is applied here, once, rather than at each of the four call sites.
 */
export function ribbonsFor(
  dayKey: string,
  data: DayContextData,
  layers: LayerState
): RibbonFact[] {
  const facts: RibbonFact[] = [];
  if (layers.bdays) {
    const target = monthDayOf(dayKey);
    for (const birthday of data.birthdays) {
      if (padded(birthday.month, birthday.day) !== target) continue;
      facts.push({
        kind: "birthday",
        id: birthday.party_id,
        text: birthday.name,
        ...(birthday.tier === "inner" ? { inner: true } : {}),
      });
    }
  }
  if (layers.hols) {
    for (const holiday of data.holidays) {
      if (holiday.day !== dayKey) continue;
      facts.push({ kind: "holiday", id: holiday.day, text: holiday.name });
    }
  }
  return facts;
}

/**
 * What the ribbon SAYS. One fact reads as itself; several collapse to a count,
 * because a month cell that spelled three names would push the day's events
 * out of the cell — and the count is the honest thing to say when the names do
 * not fit.
 */
export function ribbonLabel(facts: readonly RibbonFact[]): string {
  const first = facts[0];
  if (!first) return "";
  if (facts.length === 1) return first.text;
  const birthdays = facts.filter((fact) => fact.kind === "birthday").length;
  return birthdays === facts.length
    ? ribbonCollapsedBirthdays(birthdays)
    : ribbonCollapsed(facts.length);
}

/**
 * How many of the member's OWN tasks come due on this day (#834 R-shelf-scope).
 * The count is whatever the day-context read answered for the personal scope;
 * this never aggregates across vaults, because a shelf that counted other
 * people's work would reintroduce "someone should, so no one does".
 *
 * A day the payload does not mention is 0 — the projection lists days with
 * work, not a zero-filled histogram.
 */
export function dueCountFor(
  dayKey: string,
  data: DayContextData,
  layers: LayerState
): number {
  if (!layers.due) return 0;
  for (const fact of data.due) if (fact.day === dayKey) return fact.count;
  return 0;
}

/** The collapsed shelf's caption — `3 due`, never a chip on the grid. */
export function shelfLabel(count: number): string {
  return shelfDue(count);
}

/** The rows a day's open shelf lists. Empty whenever the layer is off, so an
 *  expanded shelf collapses with the switch rather than outliving it. */
export function dueTasksFor(
  dayKey: string,
  data: DayContextData,
  layers: LayerState
): readonly DueTask[] {
  if (!layers.due) return [];
  for (const fact of data.due) if (fact.day === dayKey) return fact.tasks ?? [];
  return [];
}

/** Does anything at all decorate the window? The rail says so rather than
 *  standing three switches over facts that do not exist. */
export function hasAnyContext(data: DayContextData): boolean {
  return (
    data.birthdays.length > 0 || data.due.length > 0 || data.holidays.length > 0
  );
}
