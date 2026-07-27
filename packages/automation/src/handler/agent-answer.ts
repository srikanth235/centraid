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
  const candidate = extractJsonFence(trimmed) ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `ctx.agent expected JSON but got: ${trimmed.slice(0, 500)} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

function extractJsonFence(text: string): string | undefined {
  const fence = '```';
  const start = text.indexOf(fence);
  if (start === -1) return undefined;
  let cursor = start + fence.length;
  const endFence = text.indexOf(fence, cursor);
  if (endFence === -1) return undefined;
  // Consume an optional `json` language tag (greedy, matching the old regex).
  if (text.slice(cursor, cursor + 4) === 'json') {
    cursor += 4;
    while (cursor < endFence && /\s/.test(text[cursor]!)) cursor += 1;
  }
  return text.slice(cursor, endFence).trim();
}
