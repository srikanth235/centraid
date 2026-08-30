// Insights' cross-surface copy and window parameters (#805, #883).
//
// `react/screens/InsightsScreen.tsx` + `react/shell/routes/InsightsRoute.tsx`
// and mobile's `apps/insights/*` render the same rollup and had four copies of
// its four sentences between them.

/** The page's ONE parameter, and its whole state. */
export const INSIGHTS_WINDOW_OPTIONS = [7, 30, 90] as const;

export const INSIGHTS_DEFAULT_WINDOW_DAYS = 30;

/** A MEMBER preference on the gateway: changing this key forks the seats. */
export const INSIGHTS_WINDOW_PREF_KEY = "insights.windowDays";

/** Guards the stored pref: a foreign value must not strand the page in a state
 *  its own chips cannot leave. */
export function isInsightsWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    (INSIGHTS_WINDOW_OPTIONS as readonly number[]).includes(value)
  );
}

export const INSIGHTS_EMPTY_TITLE = "Nothing has run yet";

/** One sentence, no action: nothing on this page makes work happen, so an
 *  empty read has nothing to offer but the reason. Already inside its budget
 *  when it moved here, so it moved unchanged. */
export const INSIGHTS_EMPTY_BODY =
  "Once automations and the assistant start doing work, their volume and outcomes appear here.";

export const INSIGHTS_ERROR_TITLE = "The run log is unavailable";

/**
 * The error body: what is true of the page right now, in one clause pair.
 *
 * It opened with "Runs are still being recorded" — reassurance in the first
 * position, before the member had been told what failed. The rebuild cadence
 * is the fact that makes the wait legible, so that is what survives.
 */
export const INSIGHTS_ERROR_BODY =
  "The rollup rebuilds every ten minutes; this rebuild has not finished.";

/** What the spend panel counts, and what it does not claim to be. */
export const INSIGHTS_SPEND_NOTE =
  "Completed runs in this vault only; estimates use public model rates.";

/** The forecast fact's note. A rate, said to be a rate. */
export const INSIGHTS_FORECAST_NOTE =
  "A 30-day run rate at this window's pace, not a bill.";

/**
 * A run's wall clock in the coarsest unit that is still true — 400 → "400 ms",
 * 95_000 → "1m 35s". A sub-second run keeps milliseconds rather than rounding
 * to the "0s" that reads as nothing having happened. One declaration for both
 * seats (#883): web's `react/format.ts` and mobile's `lib/insights.ts` re-export
 * it, so the labels agree word for word.
 */
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
