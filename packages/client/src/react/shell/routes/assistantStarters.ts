/*
 * Prompt starters for the assistant empty state (issue #420, Wave 3).
 *
 * Configurable via the gateway prefs store under `assistant.starters` (a JSON
 * string array), falling back to these defaults when unset/empty. Chosen over
 * deriving from installed apps because there is no cheap "recent activity"
 * source at the shell today — a prefs slot is the smallest honest surface and
 * mirrors the existing `model.<kind>.<subsystem>` prefs pattern.
 */

export const DEFAULT_STARTERS: readonly string[] = [
  'What did I spend the most on last month?',
  'Who have I not talked to in a while?',
  'What tasks are due this week?',
  'Which notes mention travel plans?',
];

/**
 * Resolve the empty-state starters from prefs. Non-string / blank entries are
 * dropped and the list is capped; an absent or all-blank pref yields the
 * defaults.
 */
export function resolveStarters(prefs: Record<string, unknown> | undefined): string[] {
  const raw = prefs?.['assistant.starters'];
  if (!Array.isArray(raw)) return [...DEFAULT_STARTERS];
  const cleaned = raw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 8);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_STARTERS];
}
