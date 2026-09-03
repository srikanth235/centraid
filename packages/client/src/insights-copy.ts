export const INSIGHTS_WINDOW_OPTIONS = [7, 30, 90] as const;

export const INSIGHTS_DEFAULT_WINDOW_DAYS = 30;

export const INSIGHTS_WINDOW_PREF_KEY = "insights.windowDays";

export function isInsightsWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    (INSIGHTS_WINDOW_OPTIONS as readonly number[]).includes(value)
  );
}

export const INSIGHTS_EMPTY_TITLE = "Nothing has run yet";

export const INSIGHTS_EMPTY_BODY =
  "Once automations and the assistant start doing work, their volume and outcomes appear here.";

export const INSIGHTS_ERROR_TITLE = "The run log is unavailable";

export const INSIGHTS_ERROR_BODY =
  "The rollup rebuilds every ten minutes; this rebuild has not finished.";

export const INSIGHTS_SPEND_NOTE =
  "Completed runs in this vault only; estimates use public model rates.";

export const INSIGHTS_FORECAST_NOTE =
  "A 30-day run rate at this window's pace, not a bill.";

export function insDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
