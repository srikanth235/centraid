// Automations' cross-surface copy (issue #805, slice C).
//
// `react/screens/AutomationsOverviewScreen.tsx` and mobile's
// `apps/automations/*` carried the same four sentences twice over, including
// two spellings of one `errorBody` ternary.

export const AUTOMATIONS_EMPTY_TITLE = "Nothing runs on its own yet";

/**
 * The empty body — one sentence, and the action beside it is the "Browse
 * templates" button, not a second sentence naming it (DESIGN.md → Copy).
 */
export const AUTOMATIONS_EMPTY_BODY =
  "An automation is a trigger and a thing to do.";

export const AUTOMATIONS_EMPTY_ACTION = "Browse templates";

export const AUTOMATIONS_ERROR_TITLE = "The scheduler is not answering";
export const AUTOMATIONS_ERROR_RETRY = "Reconnect";

/**
 * The error body: what happens to the work while the scheduler is away.
 *
 * It used to open with "Automations are stored on the gateway and are safe.
 * Nothing has been lost" — two promises about absence in front of the one
 * clause a member can act on. Queueing IS the promise, and it is a fact.
 *
 * The "nothing has run since 09:12" clause is DROPPED when the surface has
 * never had a successful read to take the time from: an invented clock is
 * worse than a shorter sentence.
 */
export function automationsErrorBody(sinceClock: string | undefined): string {
  return sinceClock === undefined
    ? "Runs queue until the scheduler is back."
    : `Nothing has run since ${sinceClock}; runs queue until the scheduler is back.`;
}

/**
 * The suggestions note.
 *
 * Both references say "Suggestions come from what you already do by hand",
 * which is not true of this product: the list is a curated slice of the
 * TEMPLATE CATALOGUE, keyed off a fixed id list — nothing watches what a
 * member does by hand. The provenance clause is the whole point of the note;
 * the second sentence ("They are never created for you") said the same
 * absence again and went.
 */
export const AUTOMATIONS_SUGGESTIONS_NOTE =
  "Suggestions come from the template catalogue, not from watching you.";
