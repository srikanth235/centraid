// The day-context layers on the phone (#834): birthdays from People and due
// tasks from Tasks, projected onto a day of the Agenda list.
//
// THE LIST IS FOR THINGS WITH A TIME COST. Every row on this surface came from
// `core.event`; a birthday and a due date are COSTLESS, so they decorate a
// day's header and its shelf and never become a row. That is the same ruling
// the pointer surface obeys, expressed against the replica rows the phone
// actually holds.
//
// A NATIVE REPLICA READ, NOT A SECOND STORE. The rows come from the agenda
// scope's own replica (`core.party` and `schedule.task`, both inside Agenda's
// declared read scopes), and nothing here writes. The member's OWN tasks are
// the only ones the replica holds for this seat, which is what makes the shelf
// obey #834 R-shelf-scope without a scope argument of its own.
//
// The COPY comes from the blueprints leaf both seats read
// (`apps/agenda/day-context-copy`), so the phone cannot drift from the pointer
// surface on what `3 due` says.
import {
  ribbonCollapsedBirthdays,
  shelfDue,
} from "@centraid/blueprints/apps/agenda/day-context-copy";

/** A replica row, as far as these derivations read one. */
export type ContextRow = Record<string, unknown>;

const OPEN_STATUSES = new Set(["needs-action", "in-process"]);

/** The owner's flags scheme, and the marker that means "inner circle". The
 *  same two constants the pointer surface's `day-context` query reads. */
const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
const STARRED_NOTATION = "starred";

function text(row: ContextRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

/** `YYYY-MM-DD` for a `Date`, in the device's own wall clock. */
export function dayKeyOf(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/** One costless fact about a day. */
export interface RibbonFact {
  id: string;
  text: string;
  /** Only a starred person is inner; it is the one tier the vault stores. */
  inner: boolean;
}

/** One of the member's own tasks coming due. */
export interface DueRow {
  taskId: string;
  title: string;
}

/**
 * The birthdays landing on a day. A birth date recurs annually, so it is
 * matched on `MM-DD` and the stored year is never read — both the `YYYY-MM-DD`
 * and the year-less `--MM-DD` forms the vault writes end in the same five
 * characters.
 */
export function birthdaysOn(
  dayKey: string,
  parties: readonly ContextRow[],
  starred: ReadonlySet<string>
): RibbonFact[] {
  const target = dayKey.slice(5, 10);
  return parties
    .filter((party) => {
      const kind = text(party, "kind");
      if (kind !== "" && kind !== "person") return false;
      const birth = text(party, "birth_date");
      return birth.length >= 5 && birth.slice(-5) === target;
    })
    .map((party) => ({
      id: text(party, "party_id"),
      inner: starred.has(text(party, "party_id")),
      text: text(party, "display_name"),
    }))
    .filter((fact) => fact.text !== "")
    .sort((left, right) => left.text.localeCompare(right.text));
}

/**
 * What the ribbon SAYS. One fact reads as itself; several collapse to a count,
 * because a day header that spelled three names would push the day's events
 * off the top of the screen.
 */
export function ribbonLabel(facts: readonly RibbonFact[]): string {
  const first = facts[0];
  if (!first) return "";
  if (facts.length === 1) return first.text;
  return ribbonCollapsedBirthdays(facts.length);
}

/**
 * The member's own open tasks due on a day.
 *
 * AN UNDATED TASK NEVER REACHES THE CALENDAR. A task with no `due_at` has no
 * day to be keyed to, so it cannot appear here in any code path — the same
 * property the pointer surface's projection rests on.
 */
export function dueOn(dayKey: string, tasks: readonly ContextRow[]): DueRow[] {
  return tasks
    .filter((task) => {
      const status = text(task, "status");
      if (status !== "" && !OPEN_STATUSES.has(status)) return false;
      const due = text(task, "due_at");
      return due.slice(0, 10) === dayKey;
    })
    .map((task) => ({
      taskId: text(task, "task_id"),
      title: text(task, "title"),
    }))
    .filter((row) => row.title !== "");
}

/** The collapsed shelf's caption — `3 due`, never a row on the day. */
export function shelfLabel(count: number): string {
  return shelfDue(count);
}

/**
 * Who the owner has STARRED — the vault's only stored closeness judgment about
 * a person (`packages/vault/src/commands/flags.ts`), and therefore the only
 * honest answer to "inner circle". No scheme and no marker concept means
 * nobody is starred, which is an honest `outer` for everyone rather than a
 * missing field.
 */
export function starredParties(
  schemes: readonly ContextRow[],
  concepts: readonly ContextRow[],
  tags: readonly ContextRow[]
): Set<string> {
  const schemeId = schemes.find(
    (scheme) => text(scheme, "uri") === FLAGS_SCHEME_URI
  )?.["scheme_id"];
  if (typeof schemeId !== "string") return new Set();
  const conceptId = concepts.find(
    (concept) =>
      text(concept, "scheme_id") === schemeId &&
      text(concept, "notation") === STARRED_NOTATION
  )?.["concept_id"];
  if (typeof conceptId !== "string") return new Set();
  return new Set(
    tags
      .filter(
        (tag) =>
          text(tag, "concept_id") === conceptId &&
          text(tag, "target_type") === "core.party"
      )
      .map((tag) => text(tag, "target_id"))
      .filter((id) => id !== "")
  );
}
