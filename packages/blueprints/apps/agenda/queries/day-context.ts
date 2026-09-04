/** Read-only cross-app decorations for the calendar grid (#834). Entities read
 *  here must stay in Agenda's `CHANGE_TABLES`. THIS vault only; a denial
 *  returns the same shape with `vaultDenied`. */

import {
  FLAGS_SCHEME_URI,
  STARRED_NOTATION,
  findConcept,
  findScheme,
} from "../../_shared/concept-scheme-kit.ts";
import { DAY_MS } from "../../_shared/format-kit.ts";

interface RawParty {
  party_id: string;
  kind?: string;
  display_name?: string;
  /** `YYYY-MM-DD` or the year-less `--MM-DD` the vault writes. */
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

type RelationshipTier = "inner" | "outer";

interface BirthdayFact {
  party_id: string;
  name: string;
  month: number;
  day: number;
  tier: RelationshipTier;
}

interface DueTask {
  task_id: string;
  title: string;
}

interface DueFact {
  day: string;
  count: number;
  /** In due order. A shelf lists; it never pages. */
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

// No `relationship_tier` column exists: `inner` means starred.

const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_DAYS = 45;
/** A vault has no upper bound; reads are row-capped. */
const PARTY_CAP = 2000;
const TASK_CAP = 2000;
const TAG_CAP = 5000;
const SHELF_CAP = 8;

const OPEN_STATUSES = ["needs-action", "in-process"];

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

/** An unusable range is not an error; the default window stands. */
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

/** Both stored forms end in the recurring `MM-DD`. */
function monthDayOf(birthDate: unknown): { month: number; day: number } | null {
  if (typeof birthDate !== "string" || birthDate.length < 5) return null;
  const tail = birthDate.slice(-5);
  if (!/^\d{2}-\d{2}$/u.test(tail)) return null;
  const month = Number(tail.slice(0, 2));
  const day = Number(tail.slice(3));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/** Day-by-day so Feb 29 stays absent in a non-leap year. */
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
  const { from, to } = rangeOf(input);
  try {
    // Half-open, so date-only and timed `due_at` both land.
    const dueUpper = addDays(to, 1);
    const [parties, tasks, schemes] = await Promise.all([
      ctx.vault.read({
        entity: "core.party",
        where: [
          { column: "kind", op: "eq", value: "person" },
          { column: "birth_date", op: "not-null" },
        ],
        limit: PARTY_CAP,
      }),
      ctx.vault.read({
        entity: "schedule.task",
        where: [
          { column: "status", op: "in", value: OPEN_STATUSES },
          { column: "due_at", op: "gte", value: from },
          { column: "due_at", op: "lt", value: dueUpper },
        ],
        // Due order: a shelf lists the day's earliest rows.
        orderBy: { column: "due_at", dir: "asc" },
        limit: TASK_CAP,
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.concept_scheme",
        where: [{ column: "uri", op: "eq", value: FLAGS_SCHEME_URI }],
      }),
    ]);

    // No marker means nobody is starred: an honest `outer`.
    const flagsScheme = findScheme(
      (schemes.rows ?? []) as unknown as RawScheme[],
      FLAGS_SCHEME_URI
    );
    const concepts = flagsScheme
      ? await ctx.vault.read({
          acceptTruncation: true,
          entity: "core.concept",
          where: [
            { column: "scheme_id", op: "eq", value: flagsScheme.scheme_id },
          ],
        })
      : { rows: [] };
    const starredConceptId = findConcept(
      (concepts.rows ?? []) as unknown as RawConcept[],
      flagsScheme,
      STARRED_NOTATION
    )?.concept_id;
    const starTags = starredConceptId
      ? await ctx.vault.read({
          entity: "core.tag",
          where: [
            { column: "target_type", op: "eq", value: "core.party" },
            { column: "concept_id", op: "eq", value: starredConceptId },
          ],
          limit: TAG_CAP,
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

    // Days with no due task are absent, not zero-filled.
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

    // No holiday source exists in the vault; the field holds the shape open.
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
