import {
  ribbonCollapsedBirthdays,
  shelfDue,
} from "@centraid/blueprints/apps/agenda/day-context-copy";

export type ContextRow = Record<string, unknown>;

const OPEN_STATUSES = new Set(["needs-action", "in-process"]);

const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
const STARRED_NOTATION = "starred";

function text(row: ContextRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

export function dayKeyOf(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export interface RibbonFact {
  id: string;
  text: string;
  inner: boolean;
}

export interface DueRow {
  taskId: string;
  title: string;
}

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

export function ribbonLabel(facts: readonly RibbonFact[]): string {
  const first = facts[0];
  if (!first) return "";
  if (facts.length === 1) return first.text;
  return ribbonCollapsedBirthdays(facts.length);
}

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

export function shelfLabel(count: number): string {
  return shelfDue(count);
}

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
