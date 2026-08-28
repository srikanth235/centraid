// What `[[` may point at, as a table. SEVEN KINDS; LOCKER IS NOT ONE — the
// absence is structural here and stated on the sheet's foot
// (`POWERBOX_FOOT`), so a secret can never become a link target by someone
// adding a probe. `powerbox.ts#KIND_ORDER` orders what this table yields.
//
// Both seats read this one table: the gateway query probes it with FTS, the
// phone with its replica's search. The journal exclusion (R-journal) is the
// caller's `excluded` set — a journal entry is never a link target.
import type { VaultRow } from "./filing.ts";
import type { LinkTarget } from "./types.ts";

export interface LinkTargetKind {
  app: string;
  entity: string;
  /** Column carrying the row's id. */
  id: string;
  /** First non-empty wins as the title; a row with none is not a target. */
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

/** Rows from one probe, as targets. `excluded` drops ids of that kind — the
 *  Notes probe passes the journal set, so an entry never surfaces. */
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
