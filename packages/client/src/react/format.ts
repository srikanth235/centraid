import { formatRelativeTime } from "@centraid/design";

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

export function insK(v: number): string {
  if (v >= 1_000_000) {
    return `${(v / 1_000_000).toFixed(2)}M`;
  }
  if (v >= 1_000) {
    return `${Math.round(v / 1_000)}k`;
  }
  return String(v);
}

export function insUsd(n: number): string {
  if (n > 0 && n < 0.01) {
    return "<$0.01";
  }
  return `$${n.toFixed(2)}`;
}

export { insDuration } from "../insights-copy.js";

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

export function relativeTime(
  iso: string | undefined,
  now: number = Date.now()
): string {
  return formatRelativeTime(iso, now);
}
