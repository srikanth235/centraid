// Insights' cross-surface copy (#805).
//
// `react/screens/InsightsScreen.tsx` + `react/shell/routes/InsightsRoute.tsx`
// and mobile's `apps/insights/*` render the same rollup and had four copies of
// its four sentences between them.

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
