// Which scopes an app is mounted over (issue #599), and the two questions
// every part of an app asks about them. Deliberately tiny and dependency-free
// so the store, the components and the write sites share ONE answer. An app
// becomes shareable by declaring three lines against this kit, not by writing
// its own sharing code — see `ScopeAppDeclaration` below.
//
// THE SOLO FALLBACK. A single-scope host (the served bridge, the visual
// harness mock, an older shell) publishes no `scopes` array at all. Rather than
// branching everywhere, that case is modelled as ONE scope whose id is the
// empty string — which is exactly what every scope-addressed transport reads as
// "the ambient scope". A member with one library therefore walks the same code
// path as a member with five, and sees no chips, no badges and no scope
// attributes (an empty id is never stamped).
import type { InlineScope } from "../inline-types.ts";
import { resolveWriteTarget } from "./write-target.ts";
import type { WriteTarget } from "./write-target.ts";

/** The stand-in for a host that mounts one, unnamed scope. It is the member's
 *  OWN library, so nothing in it is marked as somewhere else (§H). */
const SOLO_SCOPE: InlineScope = {
  id: "",
  label: "Library",
  personal: true,
  canWrite: true,
};

/**
 * Every mounted scope, primary (the member's own) first. Read LIVE on every
 * call: the shell hydrates audiences after first paint by pushing into the same
 * array, so a cached snapshot would miss them.
 */
export function mountedScopes(): InlineScope[] {
  const list = window.centraid?.scopes;
  return Array.isArray(list) && list.length > 0 ? list : [SOLO_SCOPE];
}

/** The member's own scope id — the shell puts the primary first, by contract. */
export function ownScopeId(
  scopes: readonly InlineScope[] = mountedScopes()
): string {
  return scopes[0]?.id ?? "";
}

/**
 * Where a CREATING write lands right now, or why it can't land at all — the
 * shared rule (apps/_shared/write-target.ts) applied to an app's two cases:
 *
 *  * `new` follows the chip selection, so "Add" while looking at Family
 *    puts the new thing in Family — and reports a read-only audience as
 *    disabled with a reason, instead of firing a write the shell would
 *    refuse.
 *  * `own` ignores the chip. Collections this app only ever authors in the
 *    member's own space resolve as if "All" were selected.
 */
export function photoWriteTarget(
  kind: "new" | "own",
  selectedScopeId: string | null,
  scopes: readonly InlineScope[] = mountedScopes()
): WriteTarget {
  return resolveWriteTarget({
    scopes,
    ownScopeId: ownScopeId(scopes),
    selectedScopeId: kind === "own" ? null : selectedScopeId,
  });
}

/**
 * May this member change things in `scopeId`? The shell already resolved the
 * answer (issue #726: a vault the member owns is writable), so controls
 * DISABLE on a `false` rather than firing a write and narrating the refusal. An id the app doesn't recognise answers
 * `true`: guessing "no" would grey out a control the shell would have accepted,
 * and the shell refuses authoritatively anyway.
 */
export function canWriteScope(scopeId: string | null | undefined): boolean {
  const scope = mountedScopes().find(
    (candidate) => candidate.id === (scopeId ?? "")
  );
  return scope ? scope.canWrite : true;
}

/**
 * The `data-scope` value for bytes owned by `scopeId`, or undefined when there
 * is nothing to say (a solo mount). Undefined is what JSX and `dataset` both
 * want for "omit the attribute", so callers never special-case the empty id.
 */
export function scopeAttr(
  scopeId: string | null | undefined
): string | undefined {
  return scopeId ? scopeId : undefined;
}

/**
 * The three facts an app declares to become shareable (issue #726 D11) —
 * nothing here is sharing CODE, only sharing DATA the shared kit consumes:
 *
 *  * `mergeKey` — the field `mergeScopePages` (`scope-merge.ts`) orders and
 *    windows a cross-scope read on. Photos: `taken_at`; a record-only app
 *    with nothing else to order by: its own row id (chronological already,
 *    e.g. a UUIDv7 primary key).
 *  * `mintedIdFamilies` — the vault entity kinds this app mints rows into
 *    (e.g. `"media.asset"`), so the closure/edge split (issue #726 §1)
 *    knows which rows are this app's to project when a share crosses a scope.
 *  * `projectionIngest` — the name of the post-ingest hook a row projected
 *    onto this app's ontology must take at the audience (issue #726 §4), so
 *    it re-enters through the SAME door authored rows use (EXIF re-link,
 *    enrichment enqueue, …). `"none"` for a record-only app with no derived
 *    state to refresh. A NAME, not a function reference: this kit is a
 *    browser ES module with no bundler (see `search-scaffold.ts`) and must
 *    never import the vault-side hook itself — the projection engine (owned
 *    by issue #726 §4) resolves the name.
 */
export interface ScopeAppDeclaration<Row> {
  mergeKey: (row: Row) => string | null | undefined;
  mintedIdFamilies: readonly string[];
  projectionIngest: "none" | string;
}
