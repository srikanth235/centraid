/**
 * The powerbox's cross-app link picker: one bounded FTS probe per target
 * entity, each failure isolated so one denied scope cannot empty the sheet.
 *
 * The Notes column excludes People-journal entries (#834 R-journal) — the
 * Journal place is their one home, and a journal entry is not a link target
 * the owner reaches for from a note. Resolving the marker is part of the
 * Notes probe, so a denial there makes the Notes column ABSENT (the same
 * outcome any other failing target gets) rather than silently unfiltered.
 */
import { readJournalNoteIds } from "../../_shared/journal-scheme.ts";

interface Target {
  app: string;
  entity: string;
  id: string;
  labels: string[];
  subtitles: string[];
}

const TARGETS: readonly Target[] = [
  {
    app: "Notes",
    entity: "knowledge.note",
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
] as const;

function first(row: Record<string, unknown>, fields: readonly string[]) {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export default async function linkTargets({ input, ctx }: HandlerArgs) {
  const term = String(input?.term ?? "").trim();
  if (!term) return { targets: [] };
  const purpose = "dpv:ServiceProvision";
  const settled = await Promise.allSettled(
    TARGETS.map(async (target) => {
      const isNotes = target.entity === "knowledge.note";
      const [result, journalNoteIds] = await Promise.all([
        ctx.vault.search({
          entity: target.entity,
          query: term,
          limit: 8,
          purpose,
        }),
        isNotes
          ? readJournalNoteIds(ctx.vault, purpose)
          : Promise.resolve(new Set<string>()),
      ]);
      return (result.rows ?? []).flatMap(
        (row: Record<string, unknown>): Array<Record<string, unknown>> => {
          const id = row[target.id];
          const title = first(row, target.labels);
          if (typeof id !== "string" || !title) return [];
          if (journalNoteIds.has(id)) return [];
          return [
            {
              type: target.entity,
              id,
              title,
              subtitle: first(row, target.subtitles) || target.app,
              app: target.app,
            },
          ];
        }
      );
    })
  );
  return {
    targets: settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    ),
  };
}
