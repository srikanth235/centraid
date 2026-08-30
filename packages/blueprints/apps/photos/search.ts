import { debounce } from "@centraid/design/elements";

// Debounce and fetch only; app.tsx owns the merge. Hits must carry `scope_id`
// — content ids collide across scopes (#599).
import { mountedScopes, ownScopeId } from "../_shared/scope-kit.ts";
import { mergeScopePages } from "../_shared/scope-merge.ts";
import { perScopeReach, scopeReachFacts } from "../_shared/search-scaffold.ts";
import type { SearchStatus } from "../_shared/search-scaffold.ts";
import {
  photoDedupeIdentity,
  photosScopeDeclaration,
} from "./scope-declaration.ts";
import type { MergeableAsset } from "./scope-declaration.ts";
import type { Asset } from "./types.ts";

// `unreachable` = NO scope answered, never "no matches" (§9). Re-exported,
// never redeclared: the scaffold owns this union (#883).
export type { SearchStatus } from "../_shared/search-scaffold.ts";

export function createSearch({
  getQuery,
  setResults,
  setStatus,
  renderGrid,
  setReachFacts,
}: {
  getQuery: () => string;
  setResults: (r: Asset[] | null) => void;
  setStatus: (status: SearchStatus) => void;
  renderGrid: () => void;
  setReachFacts?: (facts: readonly { label: string; value: string }[]) => void;
}): { run: () => void; invalidate: () => void } {
  let seq = 0;

  const run = debounce(async () => {
    const term = getQuery();
    if (!term) {
      setResults(null);
      setStatus("resting");
      setReachFacts?.([]);
      renderGrid();
      return;
    }
    const mySeq = (seq += 1);
    let assets: Asset[] = [];
    let reached = true;
    let reachFacts: Array<{ label: string; value: string }> = [];
    try {
      const client = window.centraid;
      if (typeof client.readAll === "function") {
        const results = await client.readAll<{ assets?: Asset[] }>({
          query: "search",
          input: { term },
        });
        // A short scope is neither zero hits nor grounds to blank the rest
        // (#726); `reachFacts` names it.
        const reach = perScopeReach(results);
        reached = reach.some((entry) => entry.state === "reached");
        reachFacts = scopeReachFacts(reach);
        const pages = results.map((result) => ({
          scopeId: result.scope,
          rows: (result.ok
            ? (result.data?.assets ?? [])
            : []) as unknown as readonly MergeableAsset[],
          tail: null,
          truncated: false,
        }));
        const merged = mergeScopePages(pages, {
          ownScopeId: ownScopeId(mountedScopes()),
          sortKey: photosScopeDeclaration.mergeKey,
          direction: "desc",
          dedupeIdentity: photoDedupeIdentity,
        });
        assets = merged.rows as unknown as Asset[];
      } else {
        const res = await client.read<{ assets?: Asset[] }>({
          query: "search",
          input: { term },
        });
        assets = res?.assets ?? [];
      }
    } catch {
      assets = [];
      reached = false;
    }
    if (mySeq !== seq) return; // superseded by a newer keystroke's request
    setResults(reached ? assets : null);
    setStatus(reached ? "ready" : "unreachable");
    setReachFacts?.(reached ? reachFacts : []);
    renderGrid();
  }, 150);

  function invalidate() {
    seq += 1;
  }

  return { run, invalidate };
}
