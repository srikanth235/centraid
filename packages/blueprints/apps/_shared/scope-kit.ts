import type { InlineScope } from "../inline-types.ts";
import { resolveWriteTarget } from "./write-target.ts";
import type { WriteTarget } from "./write-target.ts";

const SOLO_SCOPE: InlineScope = {
  id: "",
  label: "Library",
  personal: true,
  canWrite: true,
};

export function mountedScopes(): InlineScope[] {
  const list = window.centraid?.scopes;
  return Array.isArray(list) && list.length > 0 ? list : [SOLO_SCOPE];
}

export function ownScopeId(
  scopes: readonly InlineScope[] = mountedScopes()
): string {
  return scopes[0]?.id ?? "";
}

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

export function canWriteScope(scopeId: string | null | undefined): boolean {
  const scope = mountedScopes().find(
    (candidate) => candidate.id === (scopeId ?? "")
  );
  return scope ? scope.canWrite : true;
}

export function scopeAttr(
  scopeId: string | null | undefined
): string | undefined {
  return scopeId ? scopeId : undefined;
}

export interface ScopeAppDeclaration<Row> {
  mergeKey: (row: Row) => string | null | undefined;
  mintedIdFamilies: readonly string[];
  projectionIngest: "none" | string;
}
