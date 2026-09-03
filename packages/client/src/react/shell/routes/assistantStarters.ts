export const DEFAULT_STARTERS: readonly string[] = [
  "What did I spend the most on last month?",
  "Who have I not talked to in a while?",
  "What tasks are due this week?",
  "Which notes mention travel plans?",
];

export function resolveStarters(
  prefs: Record<string, unknown> | undefined
): string[] {
  const raw = prefs?.["assistant.starters"];
  if (!Array.isArray(raw)) return [...DEFAULT_STARTERS];
  const cleaned = raw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 8);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_STARTERS];
}
