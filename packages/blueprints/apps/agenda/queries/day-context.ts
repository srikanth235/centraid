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
import { inList, readPages } from "../../_shared/paged-reads.ts";

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
  tag_id: string;
  target_id: string;
  concept_id: string;
}

interface RawTask {
  task_id: string;
  status?: string;
  title?: string;
  due_at?: string | null;
  project_id?: string | null;
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
    const statusIn = inList("status", OPEN_STATUSES);
    const [partyRows, taskPage, schemeRows] = await Promise.all([
      ctx.vault.page<RawParty>({
        query: {
          name: "agenda.dayContext.birthdays",
          select: "party_id, display_name, kind, birth_date",
          from: "core_party",
          where: "kind = ? AND birth_date IS NOT NULL",
          bind: ["person"],
          order: {
            sortColumn: "party_id",
            pkColumn: "party_id",
            descending: false,
          },
        },
        limit: PARTY_CAP,
      }),
      // Due order: a shelf lists the day's earliest rows.
      ctx.vault.page<RawTask>({
        query: {
          name: "agenda.dayContext.dueTasks",
          select: "task_id, status, title, due_at, project_id",
          from: "schedule_task",
          // `due_at IS NOT NULL` is implied by the range either side of it and is
          // stated anyway: the paged door proves a nullable sort column
          // syntactically, and without the words a continuation over this
          // window would be refused rather than served (#1020, R-1020-35).
          where: `${statusIn.sql} AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?`,
          bind: [...statusIn.bind, from, dueUpper],
          order: {
            sortColumn: "due_at",
            pkColumn: "task_id",
            descending: false,
          },
        },
        limit: TASK_CAP,
      }),
      readPages<RawScheme>(ctx, {
        name: "agenda.dayContext.flagsScheme",
        select: "scheme_id, uri",
        from: "core_concept_scheme",
        where: "uri = ?",
        bind: [FLAGS_SCHEME_URI],
        order: {
          sortColumn: "scheme_id",
          pkColumn: "scheme_id",
          descending: false,
        },
      }),
    ]);

    // No marker means nobody is starred: an honest `outer`.
    const flagsScheme = findScheme(schemeRows, FLAGS_SCHEME_URI);
    const concepts = flagsScheme
      ? await readPages<RawConcept>(ctx, {
          name: "agenda.dayContext.flagConcepts",
          select: "concept_id, scheme_id, notation",
          from: "core_concept",
          where: "scheme_id = ?",
          bind: [flagsScheme.scheme_id],
          order: {
            sortColumn: "concept_id",
            pkColumn: "concept_id",
            descending: false,
          },
        })
      : [];
    const starredConceptId = findConcept(
      concepts,
      flagsScheme,
      STARRED_NOTATION
    )?.concept_id;
    const starTags = starredConceptId
      ? await ctx.vault.page<RawTag>({
          query: {
            name: "agenda.dayContext.starTags",
            select: "tag_id, target_type, target_id, concept_id",
            from: "core_tag",
            where: "target_type = ? AND concept_id = ?",
            bind: ["core.party", starredConceptId],
            order: {
              sortColumn: "tag_id",
              pkColumn: "tag_id",
              descending: false,
            },
          },
          limit: TAG_CAP,
        })
      : { rows: [] as RawTag[] };
    const starred = new Set(
      starTags.rows
        .filter((tag) => tag.concept_id === starredConceptId)
        .map((tag) => tag.target_id)
    );

    const birthdays: BirthdayFact[] = [];
    for (const party of partyRows.rows) {
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
    for (const task of taskPage.rows) {
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
