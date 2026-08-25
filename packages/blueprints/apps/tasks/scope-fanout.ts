// Tasks board fan-out (#726 D11): merge `open` via `mergeScopePages` only.
// Untruncated: per-scope windows already bound. A failed scope must not fold
// in as `rows: []` (#726 D10) — `reach` names it as a STATE, not empty.
import { mountedScopes, ownScopeId } from "../_shared/scope-kit.ts";
import { mergeScopePages } from "../_shared/scope-merge.ts";
import { perScopeReach } from "../_shared/search-scaffold.ts";
import type { ScopeSearchReach } from "../_shared/search-scaffold.ts";
import {
  taskDedupeIdentity,
  tasksScopeDeclaration,
} from "./scope-declaration.ts";
import type { Task } from "./types.ts";

interface BoardPayload {
  open?: Task[];
  /** Per-scope reach (#726 D10) — includes reached ones. */
  reach?: ScopeSearchReach[];
  [key: string]: unknown;
}

/** Single-scope → plain `read`. Multi-scope (#599) merges `open` only. */
export async function readBoard(
  input: Record<string, unknown>
): Promise<BoardPayload> {
  const client = window.centraid;
  const scopes = mountedScopes();
  const scopeIds = scopes.map((scope) => scope.id);
  if (scopeIds.length <= 1 || typeof client.readAll !== "function") {
    return client.read<BoardPayload>({ query: "board", input });
  }
  const results = await client.readAll<BoardPayload>({
    query: "board",
    input,
    scopes: scopeIds,
  });
  const own = ownScopeId(scopes);
  const primary = results.find((result) => result.scope === own);
  if (!primary || !primary.ok) {
    throw new Error(
      primary && !primary.ok
        ? primary.error.message
        : `own scope "${own}" not mounted`
    );
  }
  const open = mergeScopePages(
    results.map((result) => ({
      scopeId: result.scope,
      rows: result.ok ? (result.data?.open ?? []) : [],
      tail: null,
      truncated: false,
    })),
    {
      ownScopeId: own,
      sortKey: tasksScopeDeclaration.mergeKey,
      direction: "desc",
      dedupeIdentity: taskDedupeIdentity,
    }
  ).rows;
  const reach = perScopeReach(results);
  return { ...primary.data, open, reach };
}
