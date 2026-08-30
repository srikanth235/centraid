// What `[[` may point at. LOCKER IS NOT A KIND: the absence is structural, so
// a secret cannot become a link target by adding a probe. A kind names its app
// by id only — the product catalog owns the name (#883, ruling O-label).
import { apps } from "@centraid/design";

import type { VaultRow } from "./filing.ts";
import type { LinkTarget } from "./types.ts";

export interface LinkTargetKind {
  appId: string;
  entity: string;
  id: string;
  /** First non-empty wins; a row with none is not a target. */
  labels: readonly string[];
  subtitles: readonly string[];
}

export function linkTargetAppLabel(appId: string): string {
  return apps.find((app) => app.id === appId)?.name ?? appId;
}

export const NOTE_TARGET_ENTITY = "knowledge.note";

export const LINK_TARGET_KINDS: readonly LinkTargetKind[] = [
  {
    appId: "notes",
    entity: NOTE_TARGET_ENTITY,
    id: "note_id",
    labels: ["title"],
    subtitles: ["preview"],
  },
  {
    appId: "people",
    entity: "core.party",
    id: "party_id",
    labels: ["display_name"],
    subtitles: [],
  },
  {
    appId: "agenda",
    entity: "core.event",
    id: "event_id",
    labels: ["summary"],
    subtitles: ["dtstart"],
  },
  {
    appId: "tasks",
    entity: "schedule.task",
    id: "task_id",
    labels: ["title"],
    subtitles: ["due_at"],
  },
  {
    appId: "tally",
    entity: "tally.expense",
    id: "expense_id",
    labels: ["description"],
    subtitles: ["spent_on"],
  },
  {
    appId: "photos",
    entity: "core.content_item",
    id: "content_id",
    labels: ["title"],
    subtitles: ["media_type"],
  },
  {
    appId: "docs",
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

/** `excluded` drops ids of that kind (Notes passes its journal set). */
export function linkTargetsFrom(
  kind: LinkTargetKind,
  rows: readonly VaultRow[],
  excluded: ReadonlySet<string> = new Set()
): LinkTarget[] {
  const app = linkTargetAppLabel(kind.appId);
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
        subtitle: first(row, kind.subtitles) || app,
        app,
      },
    ];
  });
}
