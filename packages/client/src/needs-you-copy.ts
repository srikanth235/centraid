// Needs you's cross-surface copy (#805): one spelling of the product's promises
// about what a decision does, read by both the desktop and mobile screens —
// drift between two surfaces breaks the promise on one of them.

export const NEEDS_YOU_EMPTY_TITLE = "Nothing is waiting on you";

export const NEEDS_YOU_EMPTY_BODY =
  "Anything that needs your OK — a message waiting to send, an account to reconnect, an app asking for access — shows up here.";

export const NEEDS_YOU_EMPTY_ACTION = "Review standing grants";

export const NEEDS_YOU_DENY_TITLE = "Deny this write";
export const NEEDS_YOU_DENY_SUB =
  "Nothing is sent. The rule is told it was refused, and remembers.";

export const NEEDS_YOU_SENDING_FACT_KEY = "nothing has been sent";
export const NEEDS_YOU_SENDING_FACT_VALUE =
  "approving sends it immediately and cannot be undone";

export const NEEDS_YOU_CANNOT_EDIT_KEY = "cannot be edited";
export const NEEDS_YOU_CANNOT_EDIT_VALUE =
  "approving sends exactly what is quoted above";

export const NEEDS_YOU_GRANTS_NOTE =
  "A standing grant skips this page for one narrow thing; revoking one takes effect on the next run.";

export const NEEDS_YOU_NO_GRANTS_NOTE =
  "No standing grants yet — “always allow” on an approval adds one.";

export const NEEDS_YOU_ALWAYS_TITLE = "Approve without asking again";

export const NEEDS_YOU_EDIT_TITLE = "Edit before sending";
export const NEEDS_YOU_EDIT_SUB =
  "Your changes replace the draft above; nothing is sent until you approve.";

/** Fallback wording only: the route passes the gateway's own terms over it (#815). */
export const NEEDS_YOU_DISCARD_CONSEQUENCE =
  "Irreversible — nothing is written and the draft is destroyed.";

export const NEEDS_YOU_REVOKE_GRANT_CONSEQUENCE =
  "Matching items park for review again, including anything approved but not yet drained.";

export const NEEDS_YOU_HELD_BODY =
  "Held back while you are part-way through an item.";

export const NEEDS_YOU_REFUSED_TITLE = "The gateway refused that approval";

export const NEEDS_YOU_OLD_GATEWAY_TITLE =
  "This gateway is older than the consent ledger";
export const NEEDS_YOU_OLD_GATEWAY_BODY =
  "It cannot say which questions were answered.";

// Seat-neutral on purpose (#1015 R-NY-2): both seats render these, and a
// failed READ changes nothing — which is the one thing a member deciding on a
// write needs to know when the queue does not arrive.
export const NEEDS_YOU_ERROR_TITLE = "Could not read what is waiting on you";
export const NEEDS_YOU_ERROR_BODY = "Nothing waiting was sent or changed.";

export const NEEDS_YOU_HEALTH_DETAIL = "Nothing here happens until you decide.";
