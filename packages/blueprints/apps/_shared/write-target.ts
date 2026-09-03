import type { InlineScope } from "../inline-types.ts";

export type WriteTarget =
  | { disabled: false; scopeId: string; label: string }
  | { disabled: true; reason: string };

export interface WriteTargetInput {
  scopes: readonly InlineScope[];
  ownScopeId: string;
  selectedScopeId: string | null;
}

export function resolveWriteTarget(input: WriteTargetInput): WriteTarget {
  const { scopes, ownScopeId, selectedScopeId } = input;
  const own = scopes.find((scope) => scope.id === ownScopeId);

  if (selectedScopeId == null || selectedScopeId === ownScopeId) {
    if (!own)
      return { disabled: true, reason: "Your own space isn’t open right now." };
    if (!own.canWrite)
      return { disabled: true, reason: `${own.label} is read-only for now.` };
    return { disabled: false, scopeId: own.id, label: own.label };
  }

  const audience = scopes.find((scope) => scope.id === selectedScopeId);
  if (!audience)
    return { disabled: true, reason: "That space isn’t open right now." };

  if (!audience.canWrite) {
    return {
      disabled: true,
      reason: `${audience.label} is read-only here.`,
    };
  }
  return { disabled: false, scopeId: audience.id, label: audience.label };
}
