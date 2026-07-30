import type { ReplicaValue } from "@centraid/client/replica/native";

export interface BlueprintSearchHit {
  appId: string;
  appLabel: string;
  entity: string;
  id: string;
  label: string;
  detail?: string;
}

interface SearchSession {
  search: (
    appId: string,
    request: {
      entity: string;
      query: string;
      limit: number;
    }
  ) => Promise<{ rows: Array<{ values: ReplicaValue }> }>;
}

interface SearchTarget {
  appId: string;
  appLabel: string;
  entity: string;
  idField: string;
  labelFields: string[];
  detailFields: string[];
}

export const BLUEPRINT_SEARCH_TARGETS: readonly SearchTarget[] = [
  {
    appId: "agenda",
    appLabel: "Agenda",
    entity: "core.event",
    idField: "event_id",
    labelFields: ["summary"],
    detailFields: ["description", "dtstart"],
  },
  {
    appId: "tasks",
    appLabel: "Tasks",
    entity: "schedule.task",
    idField: "task_id",
    labelFields: ["title"],
    detailFields: ["description", "due_at"],
  },
  {
    appId: "people",
    appLabel: "People",
    entity: "core.party",
    idField: "party_id",
    labelFields: ["display_name"],
    detailFields: [],
  },
  {
    appId: "notes",
    appLabel: "Notes",
    entity: "knowledge.note",
    idField: "note_id",
    labelFields: ["title"],
    detailFields: ["body", "_snippet"],
  },
  {
    appId: "docs",
    appLabel: "Docs",
    entity: "core.document",
    idField: "document_id",
    labelFields: ["title"],
    detailFields: ["_snippet"],
  },
  {
    appId: "photos",
    appLabel: "Photos",
    entity: "core.content_item",
    idField: "content_id",
    labelFields: ["title"],
    detailFields: ["_snippet", "media_type"],
  },
  {
    appId: "tally",
    appLabel: "Tally",
    entity: "tally.expense",
    idField: "expense_id",
    labelFields: ["description"],
    detailFields: ["spent_on", "category"],
  },
  {
    appId: "locker",
    appLabel: "Locker",
    entity: "locker.item",
    idField: "item_id",
    labelFields: ["title"],
    detailFields: ["type"],
  },
] as const;

function textOf(
  values: Record<string, unknown>,
  fields: readonly string[]
): string | undefined {
  for (const field of fields) {
    const value = values[field];
    if (typeof value === "string" && value.trim()) {
      return value
        .replace(/[⟦⟧]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
    }
  }
  return undefined;
}

export async function searchBlueprints(
  session: SearchSession,
  query: string,
  appId?: string
): Promise<BlueprintSearchHit[]> {
  const term = query.trim();
  if (!term) return [];
  const targets = BLUEPRINT_SEARCH_TARGETS.filter(
    (target) => !appId || target.appId === appId
  );
  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      const result = await session.search(target.appId, {
        entity: target.entity,
        query: term,
        limit: 8,
      });
      return result.rows.flatMap((row): BlueprintSearchHit[] => {
        if (!row.values || Array.isArray(row.values)) return [];
        const values = row.values as Record<string, unknown>;
        const id = values[target.idField];
        const label = textOf(values, target.labelFields);
        if (typeof id !== "string" || !label) return [];
        const detail = textOf(values, target.detailFields);
        return [
          {
            appId: target.appId,
            appLabel: target.appLabel,
            entity: target.entity,
            id,
            label,
            ...(detail ? { detail } : {}),
          },
        ];
      });
    })
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
}
