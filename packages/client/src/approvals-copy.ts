// Approvals' cross-surface copy (#805): one spelling of the product's promises
// about what a decision does, read by both the desktop and mobile screens —
// drift between two surfaces breaks the promise on one of them.

export const APPROVALS_EMPTY_TITLE = "Nothing is waiting on you";

export const APPROVALS_EMPTY_BODY =
  "Staged writes, lapsed connections and access requests land here.";

export const APPROVALS_EMPTY_ACTION = "Review standing grants";

export const APPROVALS_DENY_TITLE = "Deny this write";
export const APPROVALS_DENY_SUB =
  "Nothing is sent. The automation is told it was refused, and remembers.";

export const APPROVALS_SENDING_FACT_KEY = "nothing has been sent";
export const APPROVALS_SENDING_FACT_VALUE =
  "approving sends it immediately and cannot be undone";

export const APPROVALS_CANNOT_EDIT_KEY = "cannot be edited";
export const APPROVALS_CANNOT_EDIT_VALUE =
  "the gateway has no rebuilder for this verb, so approving sends exactly what is quoted above";

export const APPROVALS_GRANTS_NOTE =
  "A standing grant skips this page for one narrow thing; revoking one takes effect on the next run.";

export const APPROVALS_NO_GRANTS_NOTE =
  "No standing grants yet — “always allow” on an approval mints one.";

export const APPROVALS_ALWAYS_TITLE = "Approve without asking again";

export const APPROVALS_EDIT_TITLE = "Edit before sending";
export const APPROVALS_EDIT_SUB =
  "Your changes replace the draft above; nothing is sent until you approve.";

/** Fallback wording only: the route passes the gateway's own terms over it (#815). */
export const APPROVALS_DISCARD_CONSEQUENCE =
  "Irreversible — nothing is written and the draft is destroyed.";

export const APPROVALS_REVOKE_GRANT_CONSEQUENCE =
  "Matching items park for review again, including anything approved but not yet drained.";

export const APPROVALS_HELD_BODY =
  "Held back while you are part-way through an item.";

export const APPROVALS_REFUSED_TITLE = "The gateway refused that approval";

export const APPROVALS_OLD_GATEWAY_TITLE =
  "This gateway is older than the consent ledger";
export const APPROVALS_OLD_GATEWAY_BODY =
  "It cannot say which questions were answered.";

export const APPROVALS_ERROR_TITLE = "Could not reach the consent store";
export const APPROVALS_ERROR_BODY =
  "The gateway answered; the queue that holds staged writes did not.";

export const APPROVALS_HEALTH_DETAIL =
  "Nothing here has happened yet — approving is the act.";
