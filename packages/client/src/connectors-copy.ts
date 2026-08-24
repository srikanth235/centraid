// Connectors' cross-surface copy (#805).
//
// `react/screens/SettingsConnectionsScreen.tsx` and mobile's
// `screens/connectors/Connectors.tsx` render the same three states from the
// same reference. One spelling, read from here by both.

export const CONNECTORS_EMPTY_TITLE = "Nothing is connected";

/**
 * The empty body — one sentence (DESIGN.md → Copy), and it is the sentence
 * that carries the promise: a connector's reach is named and narrow. The
 * dropped second sentence ("You choose the scope, and can revoke it here at
 * any time") described the page the member is already standing on.
 */
export const CONNECTORS_EMPTY_BODY =
  "A connector lets one outside service reach a named part of this vault, and nothing else.";

export const CONNECTORS_ERROR_TITLE = "Cannot read connection health";

/**
 * The error body: what failed, in the words that also say what still works.
 *
 * "Nothing has been paused" went: a third clause promising the absence of a
 * thing nobody claimed had happened.
 */
export const CONNECTORS_ERROR_BODY =
  "Connection health is unavailable; the connections themselves keep working.";
