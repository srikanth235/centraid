// Pure display formatters + small shared data for the React screens.
// Deliberate copies of the same-named helpers in app-format.ts, which reaches
// ambient globals the React island's tsconfig does not carry. Keep the two in
// step; do not collapse them into one import.
import { formatRelativeTime } from "@centraid/design";

/** Integration name → app-icon hue (a `--c-*` token suffix). */
export const INTEGRATION_HUES: Readonly<Record<string, string>> = {
  Datadog: "violet",
  Gmail: "rose",
  GitHub: "slate",
  "Google Calendar": "indigo",
  Linear: "indigo",
  Notion: "slate",
  PagerDuty: "forest",
  Sentry: "ochre",
  Slack: "violet",
  npm: "ochre",
};

/** Compact token count — 12_300 → "12k", 2_500_000 → "2.50M". */
export function insK(v: number): string {
  if (v >= 1_000_000) {
    return `${(v / 1_000_000).toFixed(2)}M`;
  }
  if (v >= 1_000) {
    return `${Math.round(v / 1_000)}k`;
  }
  return String(v);
}

/** USD with a sub-cent floor label. */
export function insUsd(n: number): string {
  if (n > 0 && n < 0.01) {
    return "<$0.01";
  }
  return `$${n.toFixed(2)}`;
}

export { insDuration } from "../insights-copy.js";

/** Run-kind → display label. */
export function insKindLabel(kind: string): string {
  if (kind === "chat") {
    return "Chat";
  }
  if (kind === "build") {
    return "Build";
  }
  if (kind === "automation") {
    return "Automation";
  }
  return kind;
}

/** Coarse relative time. `now` is injectable so tests are deterministic. */
export function relativeTime(
  iso: string | undefined,
  now: number = Date.now()
): string {
  return formatRelativeTime(iso, now);
}
