/**
 * Consent-relevant card body for Notifications decisions (#647 review of PR #655).
 *
 * The phone cards used to render only "<app> requests access" + purpose, and
 * only "<command> · <caller>" for a parked invocation — so the owner could
 * grant table-level writes, or run a destructive command, without ever seeing
 * WHAT was asked. Web has shown both since #306/#308
 * (packages/client/src/react/shell/routes/approvalsData.ts: `scopeSummary` and
 * `inputPreview`). These helpers produce the same information in one compact
 * secondary line, which is the native equivalent of web's block.
 */

/** One requested triple, as the Notifications projection sends it. */
export interface DecisionScope {
  schema: string;
  table?: string;
  verbs: string;
  rowFilter?: unknown[];
  fieldMask?: string[];
}

/**
 * Mirrors web's `scopeSummary`: `schema.table (verbs · N row rule, N fields)`,
 * comma-joined. Extent counts matter — a `read+act` on a whole table is a very
 * different ask from the same verbs behind a row filter and a field mask.
 */
export function describeScopes(
  scopes: readonly DecisionScope[] | undefined
): string {
  if (!scopes || scopes.length === 0) return "";
  return scopes
    .map((scope) => {
      const extent = [
        scope.rowFilter ? `${scope.rowFilter.length} row rule` : "",
        scope.fieldMask ? `${scope.fieldMask.length} fields` : "",
      ]
        .filter(Boolean)
        .join(", ");
      const target = `${scope.schema}${scope.table ? `.${scope.table}` : ""}`;
      return `${target} (${scope.verbs}${extent ? ` · ${extent}` : ""})`;
    })
    .join(", ");
}

/** Longest input preview a card shows before eliding; ~4 lines of small text. */
const INPUT_PREVIEW_LIMIT = 220;

/**
 * Compact, bounded preview of a parked invocation's input. Web renders the
 * pretty-printed JSON in a scrollable block; a card cannot, so this collapses
 * to one line and elides the tail rather than silently hiding the whole thing.
 * Values that cannot be serialized (cycles) still produce an honest marker
 * instead of an empty card.
 */
export function describeInvocationInput(
  input: Record<string, unknown> | undefined
): string {
  if (!input || Object.keys(input).length === 0) return "";
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return "Input could not be displayed — review on desktop before approving.";
  }
  if (!serialized) return "";
  return serialized.length > INPUT_PREVIEW_LIMIT
    ? `${serialized.slice(0, INPUT_PREVIEW_LIMIT)}…`
    : serialized;
}
