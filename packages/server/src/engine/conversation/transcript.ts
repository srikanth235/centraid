// Transcript codec for a turn's `step`/`tool` items; bad JSON degrades, never throws.

import type { Turn } from "./schema.js";

/** Retry families (#420): root + transitive `retryOf`; dangling links are
 *  their own family. */
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
  // Retries target earlier turns, so Map order is root-seq.
  const families = new Map<string, Turn[]>();
  for (const t of turns) {
    const root = rootOf(t);
    const fam = families.get(root);
    if (fam) fam.push(t);
    else families.set(root, [t]);
  }
  return [...families.values()];
}

export function parseStepOutput(outputJson: string | undefined): {
  text: string;
  error: boolean;
} {
  if (!outputJson) return { text: "", error: false };
  try {
    const parsed = JSON.parse(outputJson) as {
      text?: unknown;
      error?: unknown;
    };
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      error: parsed.error === true,
    };
  } catch {
    return { text: "", error: false };
  }
}

export function parseToolArgs(argsJson: string | undefined): {
  sql?: string;
  args?: unknown;
} {
  if (!argsJson) return {};
  try {
    return JSON.parse(argsJson) as { sql?: string; args?: unknown };
  } catch {
    return {};
  }
}

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
