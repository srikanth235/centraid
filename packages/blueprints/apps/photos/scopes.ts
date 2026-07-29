// Which scopes this Photos mount can see (issue #599), and the two questions
// every part of the app asks about them. Deliberately tiny and dependency-free
// so the store, the components and the write sites share ONE answer.
//
// THE SOLO FALLBACK. A single-scope host (the served bridge, the visual
// harness mock, an older shell) publishes no `scopes` array at all. Rather than
// branching everywhere, that case is modelled as ONE scope whose id is the
// empty string — which is exactly what every scope-addressed transport reads as
// "the ambient scope". A member with one library therefore walks the same code
// path as a member with five, and sees no chips, no badges and no scope
// attributes (an empty id is never stamped).
import { resolveWriteTarget } from "../_shared/write-target.ts";
import type { WriteTarget } from "../_shared/write-target.ts";
import type { InlineScope } from "../inline-types.ts";

/** The stand-in for a host that mounts one, unnamed scope. */
const SOLO_SCOPE: InlineScope = { id: "", label: "Library", canWrite: true };

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
 * shared rule (apps/_shared/write-target.ts) applied to this app's two cases:
 *
 *  * `new` follows the chip selection, so "Add media" while looking at Family
 *    puts the photo in Family — and reports a read-only audience as disabled
 *    with a reason, instead of firing a write the shell would refuse.
 *  * `own` ignores the chip. Albums, tags and places are per-scope collections
 *    this app only ever authors in the member's own space, so they resolve as
 *    if "All" were selected.
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
 * answer from their role, so controls DISABLE on a `false` rather than firing a
 * write and narrating the refusal. An id the app doesn't recognise answers
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
