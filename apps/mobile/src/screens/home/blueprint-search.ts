import type { ReplicaValue } from "@centraid/client/replica/native";
import { apps } from "@centraid/design";
import type { IconName } from "@centraid/design";

export interface BlueprintSearchHit {
  appId: string;
  appLabel: string;
  appColor: string | undefined;
  appIconKey: IconName;
  entity: string;
  kind: string;
  id: string;
  label: string;
  detail?: string;
  meta?: string;
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
  kind: string;
  entity: string;
  idField: string;
  labelFields: string[];
  detailFields: string[];
  metaField?: string;
}

const appMetaById = new Map(apps.map((meta) => [meta.id, meta]));

export const BLUEPRINT_SEARCH_TARGETS: readonly SearchTarget[] = [
  {
    appId: "agenda",
    appLabel: "Agenda",
    kind: "event",
    entity: "core.event",
    idField: "event_id",
    labelFields: ["summary"],
    detailFields: ["description"],
    metaField: "dtstart",
  },
  {
    appId: "tasks",
    appLabel: "Tasks",
    kind: "task",
    entity: "schedule.task",
    idField: "task_id",
    labelFields: ["title"],
    detailFields: ["description"],
    metaField: "due_at",
  },
  {
    appId: "people",
    appLabel: "People",
    kind: "person",
    entity: "core.party",
    idField: "party_id",
    labelFields: ["display_name"],
    detailFields: [],
  },
  {
    appId: "notes",
    appLabel: "Notes",
    kind: "note",
    entity: "knowledge.note",
    idField: "note_id",
    labelFields: ["title"],
    detailFields: ["body", "_snippet"],
    metaField: "updated_at",
  },
  {
    appId: "docs",
    appLabel: "Docs",
    kind: "doc",
    entity: "core.document",
    idField: "document_id",
    labelFields: ["title"],
    detailFields: ["_snippet"],
    metaField: "updated_at",
  },
  {
    appId: "photos",
    appLabel: "Photos",
    kind: "photo",
    entity: "core.content_item",
    idField: "content_id",
    labelFields: ["title"],
    detailFields: ["_snippet", "media_type"],
  },
  {
    appId: "tally",
    appLabel: "Tally",
    kind: "expense",
    entity: "tally.expense",
    idField: "expense_id",
    labelFields: ["description"],
    detailFields: ["category"],
    metaField: "spent_on",
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
      const appMeta = appMetaById.get(target.appId);
      return result.rows.flatMap((row): BlueprintSearchHit[] => {
        if (!row.values || Array.isArray(row.values)) return [];
        const values = row.values as Record<string, unknown>;
        const id = values[target.idField];
        const label = textOf(values, target.labelFields);
        if (typeof id !== "string" || !label) return [];
        const detail = textOf(values, target.detailFields);
        const meta = target.metaField
          ? textOf(values, [target.metaField])
          : undefined;
        return [
          {
            appId: target.appId,
            appLabel: target.appLabel,
            appColor: appMeta?.color,
            appIconKey: appMeta?.iconKey ?? "Sparkle",
            entity: target.entity,
            kind: target.kind,
            id,
            label,
            ...(detail ? { detail } : {}),
            ...(meta ? { meta } : {}),
          },
        ];
      });
    })
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
}
