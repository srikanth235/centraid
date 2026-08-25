// N-scope library data layer (#599). A tagged burst refetches ONE scope;
// "show more" re-reads only horizon scopes from their own cursors. Ordering
// and dedupe belong to `mergeScopePages`.
import { mergeScopePages } from "../_shared/scope-merge.ts";
import type { MergeResult, ScopePage } from "../_shared/scope-merge.ts";
import {
  photoDedupeIdentity,
  photosScopeDeclaration,
} from "./scope-declaration.ts";
import type { MergeableAsset } from "./scope-declaration.ts";
import type {
  Album,
  Asset,
  LibraryData,
  MemoryMemberRow,
  MemoryRow,
  Place,
} from "./types.ts";

export type ScopeReadResult =
  | { scope: string; ok: true; data: LibraryData }
  | { scope: string; ok: false; error: { code?: string; message: string } };

export interface ScopeLibrary {
  assets: Asset[];
  albums: Album[];
  places: Place[];
  trash: Asset[];
  memories: MemoryRow[];
  memoryMembers: MemoryMemberRow[];
  tail: string | null;
  truncated: boolean;
  /** An outcome to render, not an error. */
  denied: { code?: string; message?: string } | null;
  error: string | null;
}

export interface LibraryStoreDeps {
  /** Must never reject. */
  readScopes: (
    scopeIds: readonly string[],
    input: Record<string, unknown>
  ) => Promise<ScopeReadResult[]>;
  /** Read live: audiences hydrate late. */
  scopeIds: () => string[];
  ownScopeId: () => string;
  /** A burst touching none of these is inert. */
  readTables: ReadonlySet<string>;
  schedule: (key: string, run: () => void) => void;
  onData: () => void;
  pageSize?: number;
}

export interface LibraryChangeDetail {
  tables?: string[];
  source?: string;
  scope?: string;
}

const DEFAULT_PAGE_SIZE = 500;

const emptyLibrary = (): ScopeLibrary => ({
  assets: [],
  albums: [],
  places: [],
  trash: [],
  memories: [],
  memoryMembers: [],
  tail: null,
  truncated: false,
  denied: null,
  error: null,
});

function libraryFrom(data: LibraryData): ScopeLibrary {
  return {
    assets: data.assets ?? [],
    albums: data.albums ?? [],
    places: data.places ?? [],
    trash: data.trash ?? [],
    memories: data.memories ?? [],
    memoryMembers: data.memoryMembers ?? [],
    tail: data.tail ?? null,
    truncated: Boolean(data.truncated),
    denied: data.vaultDenied ?? null,
    error: data.error ?? null,
  };
}

// Deduped by `asset_id`: a row at the cursor rides both pages.
function appendPage(prev: ScopeLibrary, data: LibraryData): ScopeLibrary {
  const next = libraryFrom(data);
  const seen = new Set(prev.assets.map((asset) => asset.asset_id));
  return {
    ...next,
    assets: [
      ...prev.assets,
      ...next.assets.filter((asset) => !seen.has(asset.asset_id)),
    ],
    albums: next.albums.length > 0 ? next.albums : prev.albums,
    places: next.places.length > 0 ? next.places : prev.places,
    trash: next.trash.length > 0 ? next.trash : prev.trash,
    memories: next.memories.length > 0 ? next.memories : prev.memories,
    memoryMembers:
      next.memoryMembers.length > 0 ? next.memoryMembers : prev.memoryMembers,
    // An empty page says "nothing older", not "no tail".
    tail: next.tail ?? prev.tail,
  };
}

export interface LibraryStore {
  refreshAll: () => Promise<void>;
  refreshScope: (scopeId: string) => Promise<void>;
  showMore: () => Promise<void>;
  handleChange: (detail: LibraryChangeDetail | undefined) => void;
  merged: () => MergeResult<MergeableAsset>;
  scope: (scopeId: string) => ScopeLibrary;
  own: () => ScopeLibrary;
  /** A live read's page; outranks any older in-flight read. */
  applyScopeData: (scopeId: string, data: LibraryData) => void;
  dispose: () => void;
}

export function createLibraryStore(deps: LibraryStoreDeps): LibraryStore {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const byScope = new Map<string, ScopeLibrary>();
  // A slow read must never overwrite a later answer.
  const generation = new Map<string, number>();
  let disposed = false;
  let mergedCache: MergeResult<MergeableAsset> | null = null;

  const bump = (scopeId: string): number => {
    const next = (generation.get(scopeId) ?? 0) + 1;
    generation.set(scopeId, next);
    return next;
  };
  const current = (scopeId: string): number => generation.get(scopeId) ?? 0;

  const scopeOf = (scopeId: string): ScopeLibrary =>
    byScope.get(scopeId) ?? emptyLibrary();

  const depthOf = (scopeId: string): number => {
    const held = scopeOf(scopeId).assets.length;
    return Math.max(pageSize, Math.ceil(held / pageSize) * pageSize);
  };

  const settle = (): void => {
    mergedCache = null;
    deps.onData();
  };

  const apply = (result: ScopeReadResult, mode: "replace" | "append"): void => {
    if (result.ok) {
      const prev = byScope.get(result.scope);
      byScope.set(
        result.scope,
        mode === "append" && prev
          ? appendPage(prev, result.data)
          : libraryFrom(result.data)
      );
      return;
    }
    // A failing scope must not blank what the others fill.
    byScope.set(result.scope, {
      ...scopeOf(result.scope),
      error: result.error.message,
    });
  };

  async function readInto(
    scopeIds: readonly string[],
    input: Record<string, unknown>,
    mode: "replace" | "append"
  ): Promise<void> {
    if (disposed || scopeIds.length === 0) return;
    const marks = new Map(scopeIds.map((id) => [id, bump(id)]));
    const results = await deps.readScopes(scopeIds, input);
    if (disposed) return;
    let applied = false;
    for (const result of results) {
      // Dropped: a newer read for this scope started.
      if (marks.get(result.scope) !== current(result.scope)) continue;
      apply(result, mode);
      applied = true;
    }
    if (applied) settle();
  }

  const merged = (): MergeResult<MergeableAsset> => {
    if (mergedCache) return mergedCache;
    const pages: ScopePage<MergeableAsset>[] = deps
      .scopeIds()
      .map((scopeId) => {
        const library = scopeOf(scopeId);
        return {
          scopeId,
          // Same row, disjoint views: neither is a subtype, so cast.
          rows: library.assets as unknown as readonly MergeableAsset[],
          tail: library.tail,
          truncated: library.truncated,
        };
      });
    mergedCache = mergeScopePages(pages, {
      ownScopeId: deps.ownScopeId(),
      sortKey: photosScopeDeclaration.mergeKey,
      direction: "desc",
      dedupeIdentity: photoDedupeIdentity,
    });
    return mergedCache;
  };

  async function refreshAll(): Promise<void> {
    const scopeIds = deps.scopeIds();
    // One limit per trip: the deepest, or deep scopes snap back.
    const limit = scopeIds.reduce(
      (deep, id) => Math.max(deep, depthOf(id)),
      pageSize
    );
    await readInto(scopeIds, { limit }, "replace");
  }

  async function refreshScope(scopeId: string): Promise<void> {
    if (!deps.scopeIds().includes(scopeId)) return;
    await readInto([scopeId], { limit: depthOf(scopeId) }, "replace");
  }

  async function showMore(): Promise<void> {
    const view = merged();
    // Empty horizon means nothing deeper exists: no-op, never a full re-read.
    const targets = view.horizonScopeIds;
    await Promise.all(
      targets.map((scopeId) => {
        const before = scopeOf(scopeId).tail;
        return readInto(
          [scopeId],
          { limit: pageSize, ...(before ? { before } : {}) },
          // Cursorless reads repeat the newest page: replace, never append.
          before ? "append" : "replace"
        );
      })
    );
  }

  function handleChange(detail: LibraryChangeDetail | undefined): void {
    if (disposed) return;
    const scope = detail?.scope;
    // A fresh scope has no page: fetch past the table gate.
    if (detail?.source === "scope-added") {
      const scopeId = scope ?? "";
      deps.schedule(`scope:${scopeId}`, () => void refreshScope(scopeId));
      return;
    }
    const tables = detail?.tables;
    // No table list means "this app acted" — always refetch.
    if (Array.isArray(tables) && tables.length > 0) {
      if (!tables.some((table) => deps.readTables.has(table))) return;
    }
    if (typeof scope === "string" && deps.scopeIds().includes(scope)) {
      deps.schedule(`scope:${scope}`, () => void refreshScope(scope));
      return;
    }
    deps.schedule("all", () => void refreshAll());
  }

  return {
    refreshAll,
    refreshScope,
    showMore,
    handleChange,
    merged,
    scope: scopeOf,
    own: () => scopeOf(deps.ownScopeId()),
    applyScopeData(scopeId, data) {
      if (disposed || !deps.scopeIds().includes(scopeId)) return;
      bump(scopeId);
      byScope.set(scopeId, libraryFrom(data));
      settle();
    },
    dispose() {
      disposed = true;
      for (const scopeId of generation.keys()) bump(scopeId);
    },
  };
}
