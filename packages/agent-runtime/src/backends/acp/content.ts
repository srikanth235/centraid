/*
 * Reading ACP `ContentBlock` payloads off the wire.
 *
 * Every `session/update` variant that carries prose (`agent_message_chunk`,
 * `agent_thought_chunk`, a failed `tool_call_update`) hands it over as either
 * a bare string, one block, or an array of blocks — and tool-call blocks nest
 * another `content` payload inside. `textOf` collapses all of those to a
 * string so the mapper never branches on block shape.
 */

/** Extract text from an ACP content block or array of blocks. */
export function textOf(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let s = '';
    for (const c of content) s += textOf(c);
    return s;
  }
  if (typeof content === 'object') {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === 'string') return rec.text;
    // tool_call_update content blocks wrap a `content` payload.
    if (rec.content !== undefined) return textOf(rec.content);
  }
  return '';
}

export function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
