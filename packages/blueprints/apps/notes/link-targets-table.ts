// What `[[` may point at, as a table. LOCKER IS NOT A KIND — the absence is
// structural, so a secret cannot become a link target by adding a probe.
import type { VaultRow } from "./filing.ts";
import type { LinkTarget } from "./types.ts";

export interface LinkTargetKind {
  app: string;
  entity: string;
  id: string;
  /** First non-empty wins; a row with none is not a target. */
  labels: readonly string[];
  subtitles: readonly string[];
}

export const NOTE_TARGET_ENTITY = "knowledge.note";

export const LINK_TARGET_KINDS: readonly LinkTargetKind[] = [
  {
    app: "Notes",
    entity: NOTE_TARGET_ENTITY,
    id: "note_id",
    labels: ["title"],
    subtitles: ["preview"],
  },
  {
    app: "People",
    entity: "core.party",
    id: "party_id",
    labels: ["display_name"],
    subtitles: [],
  },
  {
    app: "Agenda",
    entity: "core.event",
    id: "event_id",
    labels: ["summary"],
    subtitles: ["dtstart"],
  },
  {
    app: "Tasks",
    entity: "schedule.task",
    id: "task_id",
    labels: ["title"],
    subtitles: ["due_at"],
  },
  {
    app: "Tally",
    entity: "tally.expense",
    id: "expense_id",
    labels: ["description"],
    subtitles: ["spent_on"],
  },
  {
    app: "Photos",
    entity: "core.content_item",
    id: "content_id",
    labels: ["title"],
    subtitles: ["media_type"],
  },
  {
    app: "Docs",
    entity: "core.document",
    id: "document_id",
    labels: ["title"],
    subtitles: [],
  },
];

function first(row: VaultRow, fields: readonly string[]): string {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** `excluded` drops ids of that kind: the Notes probe passes the journal set,
 *  so an entry never surfaces. */
export function linkTargetsFrom(
  kind: LinkTargetKind,
  rows: readonly VaultRow[],
  excluded: ReadonlySet<string> = new Set()
): LinkTarget[] {
  return rows.flatMap((row): LinkTarget[] => {
    const id = row[kind.id];
    const title = first(row, kind.labels);
    if (typeof id !== "string" || !title) return [];
    if (excluded.has(id)) return [];
    return [
      {
        type: kind.entity,
        id,
        title,
        subtitle: first(row, kind.subtitles) || kind.app,
        app: kind.app,
      },
    ];
  });
}
