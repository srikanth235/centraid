export interface PaletteEntityHit {
  appId: string;
  appLabel: string;
  entity: string;
  kind: string;
  id: string;
  label: string;
  snippet: string;
  meta: string;
}

export interface PaletteEntitySearch {
  results: (query: string) => PaletteEntityHit[];
  ensure: (query: string) => void;
  reset: () => void;
  setOnResults: (fn: (() => void) | null) => void;
}

export interface EntityTarget {
  appId: string;
  appLabel: string;
  entity: string;
  kind: string;
  id: string;
  labels: string[];
  snippetFields: string[];
  metaFields: string[];
  recentField?: string;
  deletedColumn?: string;
}

export const PALETTE_ENTITY_TARGETS: readonly EntityTarget[] = [
  {
    appId: "agenda",
    appLabel: "Agenda",
    entity: "core.event",
    kind: "event",
    id: "event_id",
    labels: ["summary"],
    snippetFields: ["description"],
    metaFields: ["dtstart"],
    recentField: "updated_at",
  },
  {
    appId: "tasks",
    appLabel: "Tasks",
    entity: "schedule.task",
    kind: "task",
    id: "task_id",
    labels: ["title"],
    snippetFields: ["description"],
    metaFields: ["due_at"],
  },
  {
    appId: "people",
    appLabel: "People",
    entity: "core.party",
    kind: "person",
    id: "party_id",
    labels: ["display_name"],
    snippetFields: [],
    metaFields: [],
    recentField: "updated_at",
  },
  {
    appId: "notes",
    appLabel: "Notes",
    entity: "knowledge.note",
    kind: "note",
    id: "note_id",
    labels: ["title"],
    snippetFields: ["_snippet", "body"],
    metaFields: [],
    recentField: "updated_at",
    deletedColumn: "deleted_at",
  },
  {
    appId: "docs",
    appLabel: "Docs",
    entity: "core.document",
    kind: "doc",
    id: "document_id",
    labels: ["title"],
    snippetFields: ["_snippet"],
    metaFields: [],
    recentField: "updated_at",
    deletedColumn: "deleted_at",
  },
  {
    appId: "photos",
    appLabel: "Photos",
    entity: "core.content_item",
    kind: "photo",
    id: "content_id",
    labels: ["title"],
    snippetFields: ["_snippet"],
    metaFields: ["media_type"],
    recentField: "created_at",
    deletedColumn: "deleted_at",
  },
  {
    appId: "tally",
    appLabel: "Tally",
    entity: "tally.expense",
    kind: "entry",
    id: "expense_id",
    labels: ["description"],
    snippetFields: ["category"],
    metaFields: ["spent_on"],
    recentField: "updated_at",
    deletedColumn: "deleted_at",
  },
  {
    appId: "locker",
    appLabel: "Locker",
    entity: "locker.item",
    kind: "item",
    id: "item_id",
    labels: ["title"],
    snippetFields: ["type"],
    metaFields: [],
    recentField: "updated_at",
    deletedColumn: "deleted_at",
  },
] as const;

export function clean(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/[⟦⟧]/gu, "")
        .replace(/\s+/gu, " ")
        .trim()
    : "";
}

export function first(
  values: Record<string, unknown>,
  fields: readonly string[]
) {
  for (const field of fields) {
    const value = clean(values[field]);
    if (value) return value;
  }
  return "";
}

export function formatMetaValue(raw: string): string {
  if (!raw) return "";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(parsed);
}

function requestOf(query: string): {
  term: string;
  targets: readonly EntityTarget[];
} {
  const trimmed = query.trim();
  const scoped = /^(?<app>[a-z]+):\s*(?<term>.*)$/iu.exec(trimmed);
  const app = scoped?.groups?.app?.toLowerCase();
  const target = app
    ? PALETTE_ENTITY_TARGETS.find(
        (candidate) =>
          candidate.appId === app || candidate.appLabel.toLowerCase() === app
      )
    : undefined;
  return {
    term: target ? (scoped?.groups?.term?.trim() ?? "") : trimmed,
    targets: target ? [target] : PALETTE_ENTITY_TARGETS,
  };
}

export async function searchPaletteEntities(
  query: string
): Promise<PaletteEntityHit[]> {
  const { term, targets } = requestOf(query);
  if (!term) return [];
  const { getReplicaShellSession } =
    await import("../../../replica/shell-session.js");
  const session = await getReplicaShellSession();
  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      const result = await session.search(target.appId, {
        entity: target.entity,
        query: term,
        limit: 6,
      });
      return result.rows.flatMap((row): PaletteEntityHit[] => {
        const values = row.values as Record<string, unknown>;
        const id = values[target.id];
        const label = first(values, target.labels);
        if (typeof id !== "string" || !label) return [];
        return [
          {
            appId: target.appId,
            appLabel: target.appLabel,
            entity: target.entity,
            kind: target.kind,
            id,
            label,
            snippet: first(values, target.snippetFields),
            meta: formatMetaValue(first(values, target.metaFields)),
          },
        ];
      });
    })
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
}

export function createPaletteEntitySearch(options?: {
  debounceMs?: number;
  search?: (query: string) => Promise<PaletteEntityHit[]>;
}): PaletteEntitySearch {
  const cache = new Map<string, PaletteEntityHit[]>();
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onResults: (() => void) | null = null;
  const search = options?.search ?? searchPaletteEntities;
  const keyOf = (query: string) => query.trim().toLowerCase();
  return {
    results(query) {
      return cache.get(keyOf(query)) ?? [];
    },
    ensure(query) {
      const key = keyOf(query);
      if (key.length < 2 || cache.has(key) || inFlight.has(key)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        inFlight.add(key);
        void search(key)
          .then((hits) => cache.set(key, hits))
          .catch(() => cache.set(key, []))
          .finally(() => {
            inFlight.delete(key);
            onResults?.();
          });
      }, options?.debounceMs ?? 150);
    },
    reset() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      cache.clear();
      inFlight.clear();
    },
    setOnResults(fn) {
      onResults = fn;
    },
  };
}
