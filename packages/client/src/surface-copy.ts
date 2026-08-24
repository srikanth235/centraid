// The words every operational page shares (#805).
//
// Approvals, Connectors, Atlas, Automations, Insights and Devices all draw the
// same three moments — reading, nothing to attend to, could not load — and
// desktop drew them from `react/shell/routeVitals.ts` while mobile re-declared
// them once per screen model. Six spellings of one sentence is the drift a
// shared constant exists to make impossible, so the WORDS live here and
// `routeVitals.ts` re-exports them for the web shell that already knows it.
//
// Why `@centraid/client` and not `@centraid/design`: same reason as
// `home-copy.ts` — design owns tokens and app metadata, not screen prose, and
// client is the module boundary mobile already imports across.

/** What a page says while it is still reading. The same on all six. */
export const READING_HEALTH = "Reading from the gateway";

/**
 * The status line when there is nothing to attend to.
 *
 * ONE CLAUSE (DESIGN.md → Copy). A second — "· nothing needs you here right
 * now" — says the first clause again in the register of a product reassuring
 * itself. Empty is the healthy state for a consent surface
 * and the four words say so.
 */
export const EMPTY_HEALTH = "Nothing to attend to";

/**
 * The status line when the page's own query failed.
 *
 * The dropped half was "· everything else on the gateway is unaffected", the
 * house tic this rulebook names: a fact followed by a sentence about what was
 * not lost. One page failing has never implicated the rest of the gateway, and
 * saying so on every failure teaches a member to read the denial, not the fact.
 */
export const ERROR_HEALTH = "This page could not load";

/**
 * The note under a page skeleton. What the skeleton promises, said once.
 *
 * Inside its budget as written — one sentence, no filler — so it moved here
 * unchanged rather than being rewritten for the sake of the move.
 */
export const SKELETON_NOTE =
  "A row knows its shape before its content arrives, so nothing reflows when it does.";

/** The verb every failed operational page offers. */
export const RETRY_ACTION = "Try again";
