export interface DecisionScope {
  schema: string;
  table?: string;
  verbs: string;
  rowFilter?: unknown[];
  fieldMask?: string[];
}

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

const INPUT_PREVIEW_LIMIT = 220;

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
