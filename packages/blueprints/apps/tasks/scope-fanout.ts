// The Tasks board's cross-scope read (issue #726 D11 task 3): fans the
// `board` query across every mounted scope and merges the `open` lists
// through the shared kit (apps/_shared/scope-kit.ts, scope-merge.ts) — no
// merge logic of Tasks' own, only the two parameters `mergeScopePages`
// needs (this app's `mergeKey`/identity live in scope-declaration.ts).
//
// UNTRUNCATED BY CONSTRUCTION. `queries/board.ts` already bounds each
// scope's own read to the caller's window, so the cross-scope merge here
// only orders, dedupes and tags `scope_id` — it never withholds a row for
// depth reasons. That is the same line Photos' unbounded search fan-out
// (search.ts) draws, for the same reason: a bounded per-scope window with
// nothing paginated ACROSS scopes has no horizon to reconcile.
//
// PER-SCOPE REACH (issue #726 D10/D11 finding 3). A scope that failed to
// answer used to fold into the merge as `rows: []` and vanish — a borrowed
// list that could not be reached rendered identically to one that is
// genuinely empty, the exact failure D10 exists to beat. `reach` on the
// returned payload names every scope's own state (`perScopeReach`) so a
// caller can render an unreached list as a STATE beside whatever other
// scopes still answered, instead of a silent "nothing open here".
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
  /** Per-scope reach for this fan-out (#726 D10/D11) — present only for a
   *  multi-scope mount (a single-scope host's plain `read` has no fan-out to
   *  report on). One entry per fanned-out scope, including the reached ones,
   *  so a caller can tell "this scope is genuinely empty" apart from "this
   *  scope could not be asked" without a second round trip. */
  reach?: ScopeSearchReach[];
  [key: string]: unknown;
}

/**
 * The board read for the current mount. A single-scope host (or one whose
 * bridge has no `readAll`) gets the plain `read` it always had. A host
 * mounted over N scopes (issue #599's `multiScope: true`) fans out and
 * returns the OWN scope's answer with `open` replaced by the merge across
 * every scope that answered — logbook, projects, sections, tags and counts
 * stay the own scope's, matching what this app has always shown for them.
 *
 * Rejects exactly when a plain `read` would have: either the fetch itself
 * throws, or the own scope's fan-out entry came back failed — the same
 * shape app-root.tsx's existing `catch`/`vaultDenied` handling already
 * expects, so wiring this in changes no caller-side error handling.
 */
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
  // Every fanned-out scope's own state, own-scope-failure already having
  // thrown above — an unreached AUDIENCE scope still names itself here
  // rather than disappearing into `rows: []` above with no trace.
  const reach = perScopeReach(results);
  return { ...primary.data, open, reach };
}
