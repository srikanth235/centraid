/*
 * Coerce a host agent's final answer into the shape `ctx.delegate` promised.
 *
 * Every automation host ends a `ctx.delegate` turn with a blob of assistant
 * text and must turn it into the value the handler awaits. Shared here so
 * hosts can't drift.
 *
 * A plain prompt returns the trimmed text as-is; a `json` prompt parses it,
 * tolerating a ```json fence the model may wrap around the object.
 */
export function coerceDelegateAnswer(text: string, json: unknown): unknown {
  const trimmed = text.trim();
  if (!json) return trimmed;
  const fenced = /```(?:json)?\s*(?<body>[\s\S]*?)```/u.exec(trimmed);
  const candidate = fenced?.groups?.body?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new Error(
      `ctx.delegate expected JSON but got: ${trimmed.slice(0, 500)} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
}
