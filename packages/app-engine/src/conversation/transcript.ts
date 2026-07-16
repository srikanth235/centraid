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

import type { Turn } from './schema.js';

/**
 * Group a conversation's turns (seq ASC) into retry families for the
 * linear-with-retry transcript (issue #420). A family is a root turn plus every
 * turn that (transitively) `retryOf`-chains back to it; families come back in
 * root-seq order, each family seq-ordered (oldest attempt first, newest last).
 * A `retryOf` that doesn't resolve to a turn in this set starts its own family,
 * so a dangling retry still renders.
 */
export function groupRetryFamilies(turns: readonly Turn[]): Turn[][] {
  const byId = new Map(turns.map((t) => [t.turnId, t]));
  const rootOf = (turn: Turn): string => {
    let cur = turn;
    const seen = new Set<string>();
    while (cur.retryOf && byId.has(cur.retryOf) && !seen.has(cur.turnId)) {
      seen.add(cur.turnId);
      cur = byId.get(cur.retryOf) as Turn;
    }
    return cur.turnId;
  };
  // `turns` is seq ASC and a retry always targets an earlier turn, so each
  // root is first seen at its own position — Map insertion order is root-seq
  // order, and each family fills in seq order.
  const families = new Map<string, Turn[]>();
  for (const t of turns) {
    const root = rootOf(t);
    const fam = families.get(root);
    if (fam) fam.push(t);
    else families.set(root, [t]);
  }
  return [...families.values()];
}

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
