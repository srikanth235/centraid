// The N-scope library data layer (issue #599). Owns one page per mounted scope
// and the merged timeline over them, so app-root.tsx keeps only rendering and
// the store keeps every rule about WHICH scope gets re-read WHEN.
//
// Three properties this file exists to guarantee:
//
//  1. A change-feed burst refetches ONE scope. The shell tags every burst with
//     the scope it came from; refetching all N on each would turn a busy
//     audience into an N× read storm on a device that is already the weakest
//     link. Only an untagged burst (a host that cannot say) falls back to all.
//  2. "Show more" re-queries only the scopes AT the horizon, each with its own
//     `before` cursor, and APPENDS. Growing one `limit` and re-reading every
//     scope from zero is quadratic in the number of pages; the keyset cursor
//     (queries/library.ts) exists precisely so it doesn't have to be.
//  3. Nothing here touches the DOM, `window.centraid` or the kit. Every effect
//     arrives through `deps`, which is what makes the two rules above testable
//     as units (src/photos-library-store.test.ts) rather than as a mounted app.
//
// The merge itself — ordering, cross-scope dedupe, the shared safe horizon —
// lives in merge.ts and is deliberately not re-derived here.
import { mergeScopePages, type MergeAsset, type MergeResult } from './merge.ts';
import type { Album, Asset, LibraryData, Place } from './types.ts';

/** What one scope answered, or why it couldn't. Errors are data, never throws. */
export type ScopeReadResult =
  | { scope: string; ok: true; data: LibraryData }
  | { scope: string; ok: false; error: { code?: string; message: string } };

/** One scope's accumulated library: page 1 plus every "show more" page after. */
export interface ScopeLibrary {
  assets: Asset[];
  albums: Album[];
  places: Place[];
  trash: Asset[];
  /** The oldest `taken_at` reached so far — the next `before` cursor. */
  tail: string | null;
  /** Older assets exist beyond what this scope has paged in. */
  truncated: boolean;
  /** A consent denial, which is an outcome to render, not an error. */
  denied: { code?: string; message?: string } | null;
  /** Anything else that went wrong reading this scope. */
  error: string | null;
}

export interface LibraryStoreDeps {
  /** Fan the `library` query across the named scopes. Must never reject. */
  readScopes: (
    scopeIds: readonly string[],
    input: Record<string, unknown>,
  ) => Promise<ScopeReadResult[]>;
  /** The mounted scope ids, primary first — read live (audiences hydrate late). */
  scopeIds: () => string[];
  /** The member's own scope id: the dedupe winner and the default write target. */
  ownScopeId: () => string;
  /** The change-feed table gate — a burst touching none of these changes nothing. */
  readTables: ReadonlySet<string>;
  /** Defer `run` under `key`, collapsing repeats (a debounce in the app). */
  schedule: (key: string, run: () => void) => void;
  /** Fired after any applied read; the app re-renders from `merged()`. */
  onData: () => void;
  /** Live assets per page. */
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
  tail: null,
  truncated: false,
  denied: null,
  error: null,
});

/** One read's answer folded into a scope's state, replacing its pages. */
function libraryFrom(data: LibraryData): ScopeLibrary {
  return {
    assets: data.assets ?? [],
    albums: data.albums ?? [],
    places: data.places ?? [],
    trash: data.trash ?? [],
    tail: data.tail ?? null,
    truncated: Boolean(data.truncated),
    denied: data.vaultDenied ?? null,
    error: data.error ?? null,
  };
}

/**
 * A deeper page folded onto what a scope already holds. Assets append (they are
 * strictly older than everything already there), deduped by `asset_id` because
 * an asset whose timestamp equals the cursor can legitimately ride both pages.
 * The album/place/trash lists are whole-collection reads that the cursor does
 * not window, so the newer page's copies stand.
 */
function appendPage(prev: ScopeLibrary, data: LibraryData): ScopeLibrary {
  const next = libraryFrom(data);
  const seen = new Set(prev.assets.map((asset) => asset.asset_id));
  return {
    ...next,
    assets: [...prev.assets, ...next.assets.filter((asset) => !seen.has(asset.asset_id))],
    albums: next.albums.length > 0 ? next.albums : prev.albums,
    places: next.places.length > 0 ? next.places : prev.places,
    trash: next.trash.length > 0 ? next.trash : prev.trash,
    // A page that came back empty says "nothing older", not "I forgot my tail".
    tail: next.tail ?? prev.tail,
  };
}

export interface LibraryStore {
  /** Re-read every mounted scope from the newest end, at its current depth. */
  refreshAll: () => Promise<void>;
  /** Re-read exactly one scope. The change-feed path, and the only cheap one. */
  refreshScope: (scopeId: string) => Promise<void>;
  /** Page the horizon scopes deeper, each from its own cursor, and append. */
  showMore: () => Promise<void>;
  /** Route one change-feed burst to the smallest refetch that answers it. */
  handleChange: (detail: LibraryChangeDetail | undefined) => void;
  /** The merged timeline across scopes (memoized until the next read lands). */
  merged: () => MergeResult;
  /** One scope's accumulated library, empty when it has never answered. */
  scope: (scopeId: string) => ScopeLibrary;
  /** The member's own scope's library — albums, places and trash come from here. */
  own: () => ScopeLibrary;
  /**
   * Apply a page a LIVE read pushed (single-scope hosts, where the replica can
   * hand the app a fresh projection without a round trip). Treated as the
   * newest answer for that scope, so an older in-flight read cannot clobber it.
   */
  applyScopeData: (scopeId: string, data: LibraryData) => void;
  /** Fence every in-flight read; nothing applies after this. */
  dispose: () => void;
}

export function createLibraryStore(deps: LibraryStoreDeps): LibraryStore {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const byScope = new Map<string, ScopeLibrary>();
  // Per-scope read generation: a slower earlier read must never overwrite a
  // later one's answer, and disposal bumps every generation at once.
  const generation = new Map<string, number>();
  let disposed = false;
  let mergedCache: MergeResult | null = null;

  const bump = (scopeId: string): number => {
    const next = (generation.get(scopeId) ?? 0) + 1;
    generation.set(scopeId, next);
    return next;
  };
  const current = (scopeId: string): number => generation.get(scopeId) ?? 0;

  const scopeOf = (scopeId: string): ScopeLibrary => byScope.get(scopeId) ?? emptyLibrary();

  /** How deep this scope currently is, rounded up to whole pages. */
  const depthOf = (scopeId: string): number => {
    const held = scopeOf(scopeId).assets.length;
    return Math.max(pageSize, Math.ceil(held / pageSize) * pageSize);
  };

  const settle = (): void => {
    mergedCache = null;
    deps.onData();
  };

  /** Fold one scope's answer in. A failed read leaves the last good page alone. */
  const apply = (result: ScopeReadResult, mode: 'replace' | 'append'): void => {
    if (result.ok) {
      const prev = byScope.get(result.scope);
      byScope.set(
        result.scope,
        mode === 'append' && prev ? appendPage(prev, result.data) : libraryFrom(result.data),
      );
      return;
    }
    // Keep whatever this scope last showed and record why it is stale — a
    // failing audience must not blank the timeline the other scopes still fill.
    byScope.set(result.scope, {
      ...scopeOf(result.scope),
      error: result.error.message,
    });
  };

  async function readInto(
    scopeIds: readonly string[],
    input: Record<string, unknown>,
    mode: 'replace' | 'append',
  ): Promise<void> {
    if (disposed || scopeIds.length === 0) return;
    const marks = new Map(scopeIds.map((id) => [id, bump(id)]));
    const results = await deps.readScopes(scopeIds, input);
    if (disposed) return;
    let applied = false;
    for (const result of results) {
      // Dropped when a newer read for THIS scope started while we were waiting.
      if (marks.get(result.scope) !== current(result.scope)) continue;
      apply(result, mode);
      applied = true;
    }
    if (applied) settle();
  }

  const merged = (): MergeResult => {
    if (mergedCache) return mergedCache;
    const pages = deps.scopeIds().map((scopeId) => {
      const library = scopeOf(scopeId);
      return {
        scopeId,
        // `Asset` and `MergeAsset` describe the SAME query row from two sides:
        // the merge names the three columns it orders and dedupes on and takes
        // the rest as `unknown`, while `Asset` names the columns the UI paints.
        // Neither is a subtype of the other, so the bridge is a cast — with the
        // asset rows themselves untouched in either direction.
        assets: library.assets as unknown as readonly MergeAsset[],
        tail: library.tail,
        truncated: library.truncated,
      };
    });
    mergedCache = mergeScopePages(pages, { ownScopeId: deps.ownScopeId() });
    return mergedCache;
  };

  async function refreshAll(): Promise<void> {
    const scopeIds = deps.scopeIds();
    // One round trip, so one limit: the deepest scope's, which keeps a scope
    // that has already paged deep from snapping back to page 1 on a refresh.
    const limit = scopeIds.reduce((deep, id) => Math.max(deep, depthOf(id)), pageSize);
    await readInto(scopeIds, { limit }, 'replace');
  }

  async function refreshScope(scopeId: string): Promise<void> {
    if (!deps.scopeIds().includes(scopeId)) return;
    await readInto([scopeId], { limit: depthOf(scopeId) }, 'replace');
  }

  async function showMore(): Promise<void> {
    const view = merged();
    // The horizon names the truncated scopes holding the merged list back. When
    // the merge reports truncation with nobody at the horizon there is nothing
    // deeper to ask for, so this is a no-op rather than a blind re-read of all.
    const targets = view.horizonScopeIds;
    await Promise.all(
      targets.map((scopeId) => {
        const before = scopeOf(scopeId).tail;
        return readInto(
          [scopeId],
          { limit: pageSize, ...(before ? { before } : {}) },
          // Without a cursor the query returns the same newest page again;
          // replacing (not appending) keeps that from being a no-op that also
          // strands the accumulated depth.
          before ? 'append' : 'replace',
        );
      }),
    );
  }

  function handleChange(detail: LibraryChangeDetail | undefined): void {
    if (disposed) return;
    const scope = detail?.scope;
    // A scope that just hydrated has no page at all: fetch exactly it, and
    // never mistake the arrival for a data burst that the table gate can drop.
    if (detail?.source === 'scope-added') {
      const scopeId = scope ?? '';
      deps.schedule(`scope:${scopeId}`, () => void refreshScope(scopeId));
      return;
    }
    const tables = detail?.tables;
    // An empty/absent table list means "this app acted" — always refetch.
    if (Array.isArray(tables) && tables.length > 0) {
      if (!tables.some((table) => deps.readTables.has(table))) return;
    }
    if (typeof scope === 'string' && deps.scopeIds().includes(scope)) {
      deps.schedule(`scope:${scope}`, () => void refreshScope(scope));
      return;
    }
    deps.schedule('all', () => void refreshAll());
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
