import type { ReplicaValue } from "@centraid/client/replica/native";
import { apps } from "@centraid/design";
import type { IconName } from "@centraid/design";

/**
 * One matched vault OBJECT — a photo, a doc, a person, a task, an event, a
 * note, a tally entry (issue #708, mobile close-out). Never "open app X": the
 * app is context for the object (the group it belongs to), not the result
 * itself. `kind` is the mono-register word the row leads with ("doc",
 * "person", "event", …); `meta` is the raw ISO instant behind the
 * numeric-register column, formatted by the caller — never pre-formatted
 * here, so this module stays a pure data fetch with no locale/date logic.
 */
export interface BlueprintSearchHit {
  appId: string;
  appLabel: string;
  /** Absent when the id is not in the design registry — the renderer supplies
   *  a neutral token rather than this layer inventing a colour. */
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
  /** Mono-register word the row leads with — "doc", "person", "event", … */
  kind: string;
  entity: string;
  idField: string;
  labelFields: string[];
  detailFields: string[];
  /** Column holding the row's date, when the entity's replica shape is known
   *  to carry one (verified against an existing read elsewhere in this repo —
   *  see the comment on each target). `undefined` means the row has no
   *  numeric-register meta rather than a guessed column that would come back
   *  empty. */
  metaField?: string;
}

const appMetaById = new Map(apps.map((meta) => [meta.id, meta]));

// Locker is NOT a search target here. Its RPC-backed items (LockerHome uses
// `appQuery("locker", "items", …)`, never a replica read) have no replica
// shape on mobile at all — the same seam useSpringboardTiles.ts documents for
// the springboard tile ("Locker issues NO read... sealed columns behind an
// online, session-gated RPC"). A search target with no shape would silently
// return zero hits forever, which is a faked affordance, not a real one; so
// Locker is excluded rather than shipped broken.
export const BLUEPRINT_SEARCH_TARGETS: readonly SearchTarget[] = [
  {
    appId: "agenda",
    appLabel: "Agenda",
    kind: "event",
    entity: "core.event",
    idField: "event_id",
    labelFields: ["summary"],
    detailFields: ["description"],
    // dtstart: read by useSpringboardTiles' `events` query and consumed via
    // `row.dtstart` in expandOccurrences, so it is a confirmed column.
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
    // due_at: already read as a detail field before this change.
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
    // updated_at: read + ordered on by useSpringboardTiles' `notes` query.
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
    // updated_at: read + ordered on by useSpringboardTiles' `documents` query.
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
    // No confirmed date column on core.content_item's search shape (photos'
    // captured_at lives on media.media_asset, a different entity) — left
    // undefined rather than guessed.
  },
  {
    appId: "tally",
    appLabel: "Tally",
    kind: "expense",
    entity: "tally.expense",
    idField: "expense_id",
    labelFields: ["description"],
    detailFields: ["category"],
    // spent_on: already read as a detail field before this change, and it is
    // the column useSpringboardTiles filters `expenses` on.
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
