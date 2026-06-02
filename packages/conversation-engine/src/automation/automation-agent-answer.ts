/*
 * Coerce a host agent's final answer into the shape `ctx.agent` promised.
 *
 * Every automation host ends a `ctx.agent` turn with a blob of assistant text
 * and must turn it into the value the handler awaits — and they must agree on
 * how. The codex/claude CLI runner (`@centraid/agent-runtime`) and the OpenClaw
 * embedded runner (`@centraid/openclaw-plugin`) had their own copies of this;
 * it lives here so the two hosts can't drift.
 *
 * A plain prompt returns the trimmed text as-is; a `json` prompt parses it,
 * tolerating a ```json fence the model may wrap around the object.
 */
export function coerceAgentAnswer(text: string, json: unknown): unknown {
  const trimmed = text.trim();
  if (!json) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (err) {
    throw new Error(
      `ctx.agent expected JSON but got: ${trimmed.slice(0, 500)} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}
