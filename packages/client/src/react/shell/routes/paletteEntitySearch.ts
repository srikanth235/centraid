export interface PaletteEntityHit {
  appId: string;
  appLabel: string;
  entity: string;
  id: string;
  label: string;
  snippet: string;
}

export interface PaletteEntitySearch {
  results: (query: string) => PaletteEntityHit[];
  ensure: (query: string) => void;
  reset: () => void;
  setOnResults: (fn: (() => void) | null) => void;
}

interface EntityTarget {
  appId: string;
  appLabel: string;
  entity: string;
  id: string;
  labels: string[];
  snippets: string[];
}

export const PALETTE_ENTITY_TARGETS: readonly EntityTarget[] = [
  {
    appId: "agenda",
    appLabel: "Agenda",
    entity: "core.event",
    id: "event_id",
    labels: ["summary"],
    snippets: ["description", "dtstart"],
  },
  {
    appId: "tasks",
    appLabel: "Tasks",
    entity: "schedule.task",
    id: "task_id",
    labels: ["title"],
    snippets: ["description", "due_at"],
  },
  {
    appId: "people",
    appLabel: "People",
    entity: "core.party",
    id: "party_id",
    labels: ["display_name"],
    snippets: [],
  },
  {
    appId: "notes",
    appLabel: "Notes",
    entity: "knowledge.note",
    id: "note_id",
    labels: ["title"],
    snippets: ["_snippet", "body"],
  },
  {
    appId: "docs",
    appLabel: "Docs",
    entity: "core.document",
    id: "document_id",
    labels: ["title"],
    snippets: ["_snippet"],
  },
  {
    appId: "photos",
    appLabel: "Photos",
    entity: "core.content_item",
    id: "content_id",
    labels: ["title"],
    snippets: ["_snippet", "media_type"],
  },
  {
    appId: "tally",
    appLabel: "Tally",
    entity: "tally.expense",
    id: "expense_id",
    labels: ["description"],
    snippets: ["spent_on", "category"],
  },
  {
    appId: "locker",
    appLabel: "Locker",
    entity: "locker.item",
    id: "item_id",
    labels: ["title"],
    snippets: ["type"],
  },
] as const;

function clean(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/[⟦⟧]/gu, "")
        .replace(/\s+/gu, " ")
        .trim()
    : "";
}

function first(values: Record<string, unknown>, fields: readonly string[]) {
  for (const field of fields) {
    const value = clean(values[field]);
    if (value) return value;
  }
  return "";
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
  // Load the replica owner only when a real search executes. Besides keeping
  // the palette source independently testable, this avoids eagerly booting the
  // renderer bridge just because the command palette module was imported.
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
            id,
            label,
            snippet: first(values, target.snippets),
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
