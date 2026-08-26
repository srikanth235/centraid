// Stateless formatters. Relative time is the shared design contract.
import { formatRelativeTime } from "@centraid/design";

// Fixed colour identity per icon. Sparkle (drafts / pre-inference) is violet.
const CANONICAL_ICON_COLOR_KEY: Record<string, ColorKeyType> = {
  Gift: "violet",
  Habit: "rose",
  Journal: "amber",
  Mood: "violet",
  Plant: "slate",
  Pomodoro: "forest",
  Sparkle: "violet",
  Spend: "ochre",
  Todo: "indigo",
  Water: "teal",
};

export function colorKeyForIcon(iconKey: IconNameType | string): ColorKeyType {
  return CANONICAL_ICON_COLOR_KEY[iconKey] ?? "violet";
}

export function colorForIcon(iconKey: IconNameType | string): ColorHexType {
  const c = (ICON_PALETTE as unknown as Record<string, ColorHexType>)[
    colorKeyForIcon(iconKey)
  ];
  return c ?? ("#7C5BD9" as ColorHexType);
}

/**
 * Tile identity from listing `app.json` keys (#263). Validate against Icon
 * / palette before trusting. Neither key resolves → `null` (legacy fallback).
 */
export function tileVisualFromListing(row: {
  iconKey?: string;
  colorKey?: string;
}): {
  iconKey: IconNameType;
  colorKey: ColorKeyType;
  color: ColorHexType;
} | null {
  const iconOk =
    !!row.iconKey && !!(Icon as Record<string, unknown>)[row.iconKey];
  const palette = ICON_PALETTE as unknown as Record<string, ColorHexType>;
  const colorOk = !!row.colorKey && !!palette[row.colorKey];
  if (!iconOk && !colorOk) return null;
  const iconKey = (iconOk ? row.iconKey : "Sparkle") as IconNameType;
  const colorKey = (
    colorOk ? row.colorKey : colorKeyForIcon(iconKey)
  ) as ColorKeyType;
  return {
    iconKey,
    colorKey,
    color: palette[colorKey] ?? colorForIcon(iconKey),
  };
}

export function relativeTime(iso?: string): string {
  return formatRelativeTime(iso);
}

export function fmtTokens(n: number): string {
  if (n <= 0) return "—";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function relativeRunLabel(d: Date): string {
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(d) - startOfDay(new Date())) / 86_400_000
  );
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const day =
    dayDiff === 0
      ? "Today"
      : dayDiff === 1
        ? "Tomorrow"
        : dayDiff > 1 && dayDiff < 7
          ? d.toLocaleDateString(undefined, { weekday: "short" })
          : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

export function runTriggerLabel(run: CentraidAutomationTurnRecord): string {
  if (run.triggerOrigin === "webhook") return "Webhook trigger";
  const byKind: Record<string, string> = {
    scheduled: "Scheduled run",
    manual: "Manual run",
    replay: "Replayed run",
    on_failure: "Failure-triggered run",
    interactive: "Interactive run",
  };
  return byKind[run.triggerKind] ?? "Run";
}

export function nodeRunStatus(
  node: CentraidAutomationItem
): "ok" | "running" | "fail" {
  if (node.endedAt === undefined && !node.error) return "running";
  return node.ok ? "ok" : "fail";
}

/**
 * 5-field cron → display. Unknown patterns fall back to the raw expr.
 * Server runs UTC; this shows local wall time.
 */
export function cronToHuman(expr: string): string {
  const fields = expr.trim().split(/\s+/u);
  if (fields.length !== 5) return expr;
  const [min, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Digits are UTC; UTC setter lets toLocaleTimeString convert to local.
  const utcAnchor = (h: number, m: number): Date => {
    const date = new Date();
    date.setUTCHours(h, m, 0, 0);
    return date;
  };
  // en-US 12h so host locale cannot drift product copy or the unit suite.
  const fmtTime = (h: number, m: number): string =>
    utcAnchor(h, m).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  // Midnight-crossing shifts weekday labels by -1/0/+1 vs the UTC day.
  const dayShift = (h: number, m: number): number => {
    const date = utcAnchor(h, m);
    const diff = (date.getDay() - date.getUTCDay() + 7) % 7;
    return diff === 6 ? -1 : diff;
  };

  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  const stepMin = min.match(/^\*\/(?<step>\d+)$/u);
  if (stepMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const n = Number(stepMin.groups?.step);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }

  if (
    min === "0" &&
    hour === "*" &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    return "Hourly";
  }

  const minNum = Number(min);
  const hourNum = Number(hour);
  const isExactTime = !Number.isNaN(minNum) && !Number.isNaN(hourNum);

  if (isExactTime && dom === "*" && month === "*") {
    const time = fmtTime(hourNum, minNum);
    if (dow === "*") return `Daily at ${time}`;
    const shift = dayShift(hourNum, minNum);
    if (shift === 0) {
      if (dow === "1-5") return `Weekdays at ${time}`;
      if (dow === "0,6" || dow === "6,0") return `Weekends at ${time}`;
    }
    // Midnight-crossing weekdays/weekends have no honest compact label.
    const single = Number(dow);
    if (!Number.isNaN(single) && single >= 0 && single <= 6) {
      return `${dayNames[(single + shift + 7) % 7]}s at ${time}`;
    }
  }

  return expr;
}

export function triggersSummary(
  triggers: ReadonlyArray<{ kind: string; expr?: string }>
): string {
  const crons = triggers.filter((t) => t.kind === "cron");
  const hasWebhook = triggers.some((t) => t.kind === "webhook");
  const hasData = triggers.some((t) => t.kind === "data");
  const hasCondition = triggers.some((t) => t.kind === "condition");
  const parts: string[] = [];
  if (crons.length === 1 && crons[0]!.expr)
    parts.push(cronToHuman(crons[0]!.expr));
  else if (crons.length > 1) parts.push(`${crons.length} schedules`);
  if (hasWebhook) parts.push("Webhook");
  if (hasData) parts.push("On data changes");
  if (hasCondition) parts.push("On condition");
  return parts.join(" · ") || "Manual only";
}

/**
 * Compact `column op value` lines. Empty `where` → `null`. Unknown shape →
 * pretty JSON. Shared by editor and view so they cannot diverge.
 */
export function formatWhereClauses(where: unknown): string | null {
  if (!Array.isArray(where) || where.length === 0) return null;
  const lines: string[] = [];
  for (const raw of where) {
    if (!raw || typeof raw !== "object") return JSON.stringify(where, null, 2);
    const c = raw as Record<string, unknown>;
    if (typeof c.column !== "string" || typeof c.op !== "string") {
      return JSON.stringify(where, null, 2);
    }
    lines.push(
      `${c.column} ${c.op}${c.value === undefined ? "" : ` ${JSON.stringify(c.value)}`}`
    );
  }
  return lines.join("\n");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function isAutomationTemplate(t: {
  kind?: "app" | "automation";
}): boolean {
  return t.kind === "automation";
}
