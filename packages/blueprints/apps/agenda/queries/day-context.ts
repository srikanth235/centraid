/**
 * Day context: the cross-app facts a calendar grid needs to decorate its days,
 * as ONE read-only server-shaped projection (#834 R-daycontext).
 *
 * Agenda's grid wants to say more about a day than "here are your events" —
 * whose birthday it is, how many tasks come due, which days are holidays.
 * They arrive here as one query, one shape, no write path, and every entity it
 * reads is registered in Agenda's `CHANGE_TABLES` so a doorbell on any of them
 * re-fetches the decorations.
 *
 * Scope (#834 R-shelf-scope): the due-task counts are THIS vault's tasks and
 * nothing else. There is deliberately no cross-vault aggregation — a shelf
 * that counts other people's work reintroduces "someone should, so no one
 * does". The vault's own scope check is what makes that true; this handler
 * simply never reaches past it.
 *
 * A consent denial is a first-class outcome, not an error: the same shape
 * comes back empty with `vaultDenied` attached, so the UI can draw an
 * undecorated grid rather than an error state.
 */

/** A `core.party` row, as far as this projection reads it. */
interface RawParty {
  party_id: string;
  kind?: string;
  display_name?: string;
  /** `YYYY-MM-DD` or the year-less ISO-8601 form the vault writes (`--MM-DD`). */
  birth_date?: string | null;
}

interface RawScheme {
  scheme_id: string;
  uri: string;
}

interface RawConcept {
  concept_id: string;
  scheme_id: string;
  notation?: string;
}

interface RawTag {
  target_id: string;
  concept_id: string;
}

interface RawTask {
  task_id: string;
  status?: string;
  title?: string;
  due_at?: string | null;
}

/** How close a person is to the owner, as the vault can actually answer it. */
type RelationshipTier = "inner" | "outer";

interface BirthdayFact {
  party_id: string;
  name: string;
  month: number;
  day: number;
  tier: RelationshipTier;
}

/** One row behind a day's shelf. Identity and title only: Agenda decorates a
 *  day with it and hands the tap-through to Tasks, which is the room that owns
 *  the task — so nothing else about it is projected here. */
interface DueTask {
  task_id: string;
  title: string;
}

interface DueFact {
  day: string;
  /** Every open task due that day, however few are listed. */
  count: number;
  /** The first `SHELF_CAP` of them, in due order. A shelf lists; it never
   *  becomes a second task board with paging of its own. */
  tasks: DueTask[];
}

interface HolidayFact {
  day: string;
  name: string;
}

interface DayContextResult {
  birthdays: BirthdayFact[];
  due: DueFact[];
  holidays: HolidayFact[];
  vaultDenied?: { code?: string; message?: string };
}

// The owner's flags scheme — one starred tag per entity is the vault's ONLY
// stored closeness judgment about a person (`packages/vault/src/commands/
// flags.ts`, mirrored by People's own `starred` projection). There is no
// `relationship_tier` column anywhere in the ontology, so `inner` means
// "the owner starred them" and `outer` means everyone else. Naming it a tier
// here rather than "starred" keeps the calendar's vocabulary about
// relationships instead of about People's UI affordance.
const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
const STARRED_NOTATION = "starred";

const DAY_MS = 86_400_000;
/** Longest window one call may ask for — a grid never shows more (#834). */
const MAX_RANGE_DAYS = 400;
/** Default forward runway when the caller passes no usable range. */
const DEFAULT_RANGE_DAYS = 45;
/** Ceilings: a vault has no upper bound, so every read is row-capped. */
const PARTY_CAP = 2000;
const TASK_CAP = 2000;
const TAG_CAP = 5000;
/** Rows one day's shelf lists behind its count. A day with nineteen due tasks
 *  says nineteen and lists the first few; the room that pages them is Tasks. */
const SHELF_CAP = 8;

/** The statuses a task must be in to count as still coming due. */
const OPEN_STATUSES = ["needs-action", "in-process"];

/** `YYYY-MM-DD` if the value carries a parseable calendar day, else null. */
function dayOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const head = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(head) ? head : null;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Normalize `{from, to}` into an inclusive day range that is always valid and
 * never longer than `MAX_RANGE_DAYS`. An unusable input is not an error: the
 * grid still has a window it means, so the default one is used.
 */
function rangeOf(input: Record<string, unknown> | undefined): {
  from: string;
  to: string;
} {
  const today = new Date().toISOString().slice(0, 10);
  const from = dayOf(input?.["from"]) ?? today;
  const asked = dayOf(input?.["to"]);
  const fallback = addDays(from, DEFAULT_RANGE_DAYS);
  const to = asked && asked >= from ? asked : fallback;
  const ceiling = addDays(from, MAX_RANGE_DAYS);
  return { from, to: to > ceiling ? ceiling : to };
}

/** The `MM-DD` a birth date recurs on — both stored forms end in it. */
function monthDayOf(birthDate: unknown): { month: number; day: number } | null {
  if (typeof birthDate !== "string" || birthDate.length < 5) return null;
  const tail = birthDate.slice(-5);
  if (!/^\d{2}-\d{2}$/u.test(tail)) return null;
  const month = Number(tail.slice(0, 2));
  const day = Number(tail.slice(3));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/**
 * Whether an annually recurring `MM-DD` falls inside `[from, to]`. Walked a
 * day at a time rather than reasoned about across year boundaries: the window
 * is capped at 400 days, and a February 29th birthday is then simply absent in
 * a non-leap year instead of being silently rounded onto a neighbouring day.
 */
function recursInRange(
  month: number,
  day: number,
  from: string,
  to: string
): boolean {
  const target = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    if (cursor.slice(5) === target) return true;
  }
  return false;
}

export default async function dayContext({
  input,
  ctx,
}: HandlerArgs): Promise<DayContextResult> {
  const purpose = "dpv:ServiceProvision";
  const { from, to } = rangeOf(input);
  try {
    // The window's task bound is a half-open instant range: `to` is inclusive
    // as a DAY, so the upper bound is the start of the day after it. That
    // catches both storage shapes — a date-only `due_at` and a timed one.
    const dueUpper = addDays(to, 1);
    const [parties, tasks, schemes] = await Promise.all([
      ctx.vault.read({
        entity: "core.party",
        where: [
          { column: "kind", op: "eq", value: "person" },
          { column: "birth_date", op: "not-null" },
        ],
        limit: PARTY_CAP,
        purpose,
      }),
      ctx.vault.read({
        entity: "schedule.task",
        where: [
          { column: "status", op: "in", value: OPEN_STATUSES },
          { column: "due_at", op: "gte", value: from },
          { column: "due_at", op: "lt", value: dueUpper },
        ],
        // Due order, so the rows a shelf lists behind its count are the day's
        // earliest rather than whatever the table happened to hand back.
        orderBy: { column: "due_at", dir: "asc" },
        limit: TASK_CAP,
        purpose,
      }),
      ctx.vault.read({
        entity: "core.concept_scheme",
        where: [{ column: "uri", op: "eq", value: FLAGS_SCHEME_URI }],
        purpose,
      }),
    ]);

    // Tier resolution is two more bounded reads, and only when the vault
    // actually has a flags scheme: the marker concept, then the party tags
    // carrying it. No scheme or no marker means nobody is starred, which is
    // an honest `outer` for everyone rather than a missing field.
    const flagsScheme = ((schemes.rows ?? []) as unknown as RawScheme[]).find(
      (scheme) => scheme.uri === FLAGS_SCHEME_URI
    );
    const concepts = flagsScheme
      ? await ctx.vault.read({
          entity: "core.concept",
          where: [
            { column: "scheme_id", op: "eq", value: flagsScheme.scheme_id },
          ],
          purpose,
        })
      : { rows: [] };
    const starredConceptId = ((concepts.rows ?? []) as unknown as RawConcept[])
      .filter((concept) => concept.scheme_id === flagsScheme?.scheme_id)
      .find((concept) => concept.notation === STARRED_NOTATION)?.concept_id;
    const starTags = starredConceptId
      ? await ctx.vault.read({
          entity: "core.tag",
          where: [
            { column: "target_type", op: "eq", value: "core.party" },
            { column: "concept_id", op: "eq", value: starredConceptId },
          ],
          limit: TAG_CAP,
          purpose,
        })
      : { rows: [] };
    const starred = new Set(
      ((starTags.rows ?? []) as unknown as RawTag[])
        .filter((tag) => tag.concept_id === starredConceptId)
        .map((tag) => tag.target_id)
    );

    const birthdays: BirthdayFact[] = [];
    for (const party of (parties.rows ?? []) as unknown as RawParty[]) {
      if (party.kind !== undefined && party.kind !== "person") continue;
      const monthDay = monthDayOf(party.birth_date);
      if (!monthDay) continue;
      if (!recursInRange(monthDay.month, monthDay.day, from, to)) continue;
      birthdays.push({
        party_id: party.party_id,
        name: party.display_name ?? "",
        month: monthDay.month,
        day: monthDay.day,
        tier: starred.has(party.party_id) ? "inner" : "outer",
      });
    }
    birthdays.sort(
      (left, right) =>
        left.month - right.month ||
        left.day - right.day ||
        left.name.localeCompare(right.name)
    );

    // Both storage shapes bucket to the calendar day their stored value
    // carries: a date-only `due_at` IS the day, and a timed one contributes
    // the day of the instant it stores. Days with no due task are absent
    // rather than zero-filled — the shelf draws marks, not a histogram.
    const counts = new Map<string, number>();
    const listed = new Map<string, DueTask[]>();
    for (const task of (tasks.rows ?? []) as unknown as RawTask[]) {
      if (task.status !== undefined && !OPEN_STATUSES.includes(task.status))
        continue;
      const day = dayOf(task.due_at);
      if (!day || day < from || day > to) continue;
      counts.set(day, (counts.get(day) ?? 0) + 1);
      const rows = listed.get(day) ?? [];
      if (rows.length < SHELF_CAP)
        rows.push({ task_id: task.task_id, title: task.title ?? "" });
      listed.set(day, rows);
    }
    const due: DueFact[] = [...counts.entries()]
      .map(([day, count]) => ({ day, count, tasks: listed.get(day) ?? [] }))
      .toSorted((left, right) => left.day.localeCompare(right.day));

    // Holidays have NO source in the vault today. There is no holiday feed,
    // no subscribed-calendar mechanism (`schedule.calendar` is owner-authored
    // and its `external_uri` is a label, not a poller), and no provider pull
    // that would write one. The field is part of the shape so the grid can be
    // built against it now; inventing storage for it is a separate ruling.
    const holidays: HolidayFact[] = [];

    return { birthdays, due, holidays };
  } catch (error) {
    const denial = error as { code?: string; message?: string };
    return {
      birthdays: [],
      due: [],
      holidays: [],
      vaultDenied: { code: denial.code, message: denial.message },
    };
  }
}
