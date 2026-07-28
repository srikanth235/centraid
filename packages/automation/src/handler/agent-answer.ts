/*
 * Coerce a host agent's final answer into the shape `ctx.agent` promised.
 *
 * Every automation host ends a `ctx.agent` turn with a blob of assistant text
 * and must turn it into the value the handler awaits. Shared here so hosts
 * can't drift.
 *
 * A plain prompt returns the trimmed text as-is; a `json` prompt parses it,
 * tolerating a ```json fence the model may wrap around the object.
 */
export function coerceAgentAnswer(text: string, json: unknown): unknown {
  const trimmed = text.trim();
  if (!json) return trimmed;
  // Strip optional ```json ... ``` fence
  let candidate = trimmed;
  if (trimmed.startsWith('```')) {
    let fenceEnd = trimmed.indexOf('\n');
    if (fenceEnd < 0) fenceEnd = trimmed.length;
    const afterOpen = fenceEnd + 1;
    const closeIdx = trimmed.indexOf('\n```', afterOpen);
    if (closeIdx >= 0) {
      candidate = trimmed.slice(afterOpen, closeIdx).trim();
    }
  }
  try {
    return JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `ctx.agent expected JSON but got: ${trimmed.slice(0, 500)} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}
