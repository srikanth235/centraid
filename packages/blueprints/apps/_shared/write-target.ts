/**
 * Where does a write land when an app is mounted over several scopes at once
 * (issue #599)? Every multi-scope app asks the same question — the timeline
 * "Add photo" button, the notes composer, the tally entry form — so the rule
 * lives here once, pure and total, instead of being re-derived per app.
 *
 * THE RULE, in order:
 *
 *  1. Nothing selected (the "All" chip) → the member's OWN scope. "All" is a
 *     reading lens, never a writing one: a merged timeline has no single place
 *     to put a new item, and silently fanning a write into every audience
 *     would be the worst possible default. New things start where the member
 *     already owns everything.
 *  2. The member's own scope selected → that scope (same as 1).
 *  3. An audience scope selected and `canWrite` → that audience.
 *  4. An audience scope selected and NOT `canWrite` → blocked, with a short
 *     human reason the caller renders on the disabled control.
 *
 * Two degenerate inputs keep the function total rather than throwing:
 * a selection naming a scope that is not mounted (the shell revoked it between
 * render and click) and an own scope that is missing or itself read-only.
 * Both resolve to case 4 with their own reason.
 *
 * VOCABULARY: no reason string here may contain the word "vault" — app-facing
 * copy speaks of scopes by their human label only.
 */
import type { InlineScope } from '../inline-types.ts';

/** Where a write goes, or why it cannot go anywhere. */
export type WriteTarget =
  | { disabled: false; scopeId: string; label: string }
  | { disabled: true; reason: string };

export interface WriteTargetInput {
  /** Every scope the app is mounted over, own scope included. */
  scopes: readonly InlineScope[];
  /** The id of the member's own scope within `scopes`. */
  ownScopeId: string;
  /** The selected chip's scope id, or null for "All". */
  selectedScopeId: string | null;
}

/**
 * Resolve the write target for the current chip selection. Total: every input
 * yields either a target or a reason, never an exception.
 */
export function resolveWriteTarget(input: WriteTargetInput): WriteTarget {
  const { scopes, ownScopeId, selectedScopeId } = input;
  const own = scopes.find((scope) => scope.id === ownScopeId);

  // Cases 1 + 2: "All" and the own chip both write to the member's own scope.
  if (selectedScopeId == null || selectedScopeId === ownScopeId) {
    if (!own) return { disabled: true, reason: 'Your own space isn’t open right now.' };
    if (!own.canWrite) return { disabled: true, reason: `You can’t add to ${own.label} yet.` };
    return { disabled: false, scopeId: own.id, label: own.label };
  }

  const audience = scopes.find((scope) => scope.id === selectedScopeId);
  // Degenerate: the chip names something the app is no longer mounted over.
  if (!audience) return { disabled: true, reason: 'That space isn’t open right now.' };

  // Case 4 before case 3 — the read-only answer is the interesting one.
  if (!audience.canWrite) {
    return { disabled: true, reason: `You can view ${audience.label} but not add to it.` };
  }
  return { disabled: false, scopeId: audience.id, label: audience.label };
}
