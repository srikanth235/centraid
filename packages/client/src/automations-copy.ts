// Automations' cross-surface copy (#805) — shared by the overview screen and
// mobile's `apps/automations/*`, which carried these sentences twice over.

export const AUTOMATIONS_EMPTY_TITLE = "Nothing runs on its own yet";

/** One sentence; the action beside it names itself (DESIGN.md → Copy). */
export const AUTOMATIONS_EMPTY_BODY =
  "An automation is a trigger and a thing to do.";

export const AUTOMATIONS_EMPTY_ACTION = "Browse templates";

export const AUTOMATIONS_ERROR_TITLE = "The scheduler is not answering";
export const AUTOMATIONS_ERROR_RETRY = "Reconnect";

/**
 * What happens to the work while the scheduler is away. Queueing IS the
 * promise — no promises about absence in front of the clause a member can act
 * on. The "nothing has run since…" clause DROPS when no successful read ever
 * took a time from: an invented clock is worse than a shorter sentence.
 */
export function automationsErrorBody(sinceClock: string | undefined): string {
  return sinceClock === undefined
    ? "Runs queue until the scheduler is back."
    : `Nothing has run since ${sinceClock}; runs queue until the scheduler is back.`;
}

/**
 * "From what you already do by hand" would be FALSE here: the list is a
 * curated slice of the TEMPLATE CATALOGUE off a fixed id list — nothing
 * watches what a member does by hand. Provenance is the whole point of the note.
 */
export const AUTOMATIONS_SUGGESTIONS_NOTE =
  "Suggestions come from the template catalogue, not from watching you.";
