/*
 * Transcript codec — the JSON shapes a chat turn's `step` / `tool` items
 * carry, plus defensive parsers.
 *
 * `ConversationHistoryStore.recordTurn` writes these shapes; `getSession` reads them
 * back to reconstruct the renderer transcript. (The inbound user message is a
 * first-class `message_in` item — its text is read directly, no codec — so
 * there is no `parseUserMessage` anymore; issue #190.) Kept in its own file so
 * the store stays focused on SQL. Every parser tolerates malformed or absent
 * JSON — a corrupt row degrades to an empty message, never throws.
 */

/** Pull the assistant text + error flag out of a `step` item's `output_json`. */
export function parseStepOutput(outputJson: string | undefined): {
  text: string;
  error: boolean;
} {
  if (!outputJson) return { text: '', error: false };
  try {
    const parsed = JSON.parse(outputJson) as { text?: unknown; error?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      error: parsed.error === true,
    };
  } catch {
    return { text: '', error: false };
  }
}

/** Pull the SQL + args out of a `tool` node's `args_json`. */
export function parseToolArgs(argsJson: string | undefined): { sql?: string; args?: unknown } {
  if (!argsJson) return {};
  try {
    return JSON.parse(argsJson) as { sql?: string; args?: unknown };
  } catch {
    return {};
  }
}

/** Pull the result + error text out of a `tool` node's `output_json`. */
export function parseToolOutput(outputJson: string | undefined): {
  result?: unknown;
  errorText?: string;
} {
  if (!outputJson) return {};
  try {
    return JSON.parse(outputJson) as { result?: unknown; errorText?: string };
  } catch {
    return {};
  }
}
