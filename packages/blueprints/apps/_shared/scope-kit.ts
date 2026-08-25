// Which scopes an app is mounted over (#599). An app becomes shareable by
// declaring `ScopeAppDeclaration`, never by writing its own sharing code.
//
// THE SOLO FALLBACK: a host publishing no `scopes` array is modelled as ONE
// scope with the EMPTY id — the ambient scope to every transport — so one
// library walks the same path as five, and no attribute is ever stamped.
import type { InlineScope } from "../inline-types.ts";
import { resolveWriteTarget } from "./write-target.ts";
import type { WriteTarget } from "./write-target.ts";

/** The member's OWN library, so nothing in it is marked elsewhere (§H). */
const SOLO_SCOPE: InlineScope = {
  id: "",
  label: "Library",
  personal: true,
  canWrite: true,
};

/** Primary (the member's own) first, read LIVE: the shell pushes hydrated
 * audiences into the same array after first paint. */
export function mountedScopes(): InlineScope[] {
  const list = window.centraid?.scopes;
  return Array.isArray(list) && list.length > 0 ? list : [SOLO_SCOPE];
}

export function ownScopeId(
  scopes: readonly InlineScope[] = mountedScopes()
): string {
  return scopes[0]?.id ?? "";
}

/** `new` follows the chip selection and disables with a reason on a read-only
 * audience; `own` ignores the chip, as if "All" were selected. */
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

/** Controls DISABLE on `false` rather than firing a doomed write. An
 * unrecognised id answers `true`: the shell refuses authoritatively anyway. */
export function canWriteScope(scopeId: string | null | undefined): boolean {
  const scope = mountedScopes().find(
    (candidate) => candidate.id === (scopeId ?? "")
  );
  return scope ? scope.canWrite : true;
}

/** `undefined` is what JSX and `dataset` read as "omit", so callers never
 * special-case the empty id. */
export function scopeAttr(
  scopeId: string | null | undefined
): string | undefined {
  return scopeId ? scopeId : undefined;
}

/**
 * The three facts an app declares to become shareable (#726).
 *
 *  * `mergeKey` — what `mergeScopePages` orders a cross-scope read on.
 *  * `mintedIdFamilies` — the entity kinds this app mints, so the closure/edge
 *    split knows which rows are its to project.
 *  * `projectionIngest` — the hook a projected row takes so it re-enters through
 *    the SAME door authored rows use. A NAME, never a function reference: this
 *    bundler-free browser module must not import the vault-side hook.
 */
export interface ScopeAppDeclaration<Row> {
  mergeKey: (row: Row) => string | null | undefined;
  mintedIdFamilies: readonly string[];
  projectionIngest: "none" | string;
}
