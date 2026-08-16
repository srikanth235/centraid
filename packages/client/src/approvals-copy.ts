// Approvals' cross-surface copy (issue #805, slice C).
//
// The desktop screen (`react/screens/ApprovalsScreen.tsx`) and the mobile
// screen model (`apps/mobile/src/screens/approvals/approvals-model.ts`) drew
// the SAME consent surface from two copies of the same block, deliberately
// duplicated: mobile's header said `packages/client` is "a browser bundle this
// app does not import", which stopped being true when mobile started importing
// `@centraid/client/replica/native` and `@centraid/client/home-copy`.
//
// These sentences are the product's promises about what a decision does. A
// promise that drifts between two surfaces is a promise broken on one of them,
// so there is one spelling and both surfaces read it from here.

/** Nothing waiting. Empty is the healthy state for a consent surface. */
export const APPROVALS_EMPTY_TITLE = "Nothing is waiting on you";

/**
 * The empty body — one sentence, one action beside it (DESIGN.md → Copy).
 *
 * It used to close with "This page is empty most of the time, and that is the
 * healthy state", a healthy-state essay under a title that already said so.
 */
export const APPROVALS_EMPTY_BODY =
  "Staged writes, lapsed connections and access requests land here.";

export const APPROVALS_EMPTY_ACTION = "Review standing grants";

/** The deny sheet. A destructive confirm — one of the few surfaces where a
 *  full second sentence is the point, because this is where the risk decision
 *  is actually made and what a denial DOES is not obvious from the verb. */
export const APPROVALS_DENY_TITLE = "Deny this write";
export const APPROVALS_DENY_SUB =
  "Nothing is sent. The automation is told it was refused, and remembers.";

/** The fact pair over a staged write: what has not happened, and what pressing
 *  approve does. Fragments, in the fact register — key then value. */
export const APPROVALS_SENDING_FACT_KEY = "nothing has been sent";
export const APPROVALS_SENDING_FACT_VALUE =
  "approving sends it immediately and cannot be undone";

/** The fact pair for a verb the gateway cannot rebuild, so the quoted artifact
 *  is exactly what leaves. */
export const APPROVALS_CANNOT_EDIT_KEY = "cannot be edited";
export const APPROVALS_CANNOT_EDIT_VALUE =
  "the gateway has no rebuilder for this verb, so approving sends exactly what is quoted above";

/** The standing-grants note. One sentence: what a grant is, and when revoking
 *  it lands. It was two, and the second started with the first one's noun. */
export const APPROVALS_GRANTS_NOTE =
  "A standing grant skips this page for one narrow thing; revoking one takes effect on the next run.";

export const APPROVALS_NO_GRANTS_NOTE =
  "No standing grants yet — “always allow” on an approval mints one.";

/** The always-allow row's title. The sheet's own sub-line differs per surface
 *  and stays with the surface that renders it. */
export const APPROVALS_ALWAYS_TITLE = "Approve without asking again";

/** The edit sheet. One sentence: what the edit replaces, and when it leaves. */
export const APPROVALS_EDIT_TITLE = "Edit before sending";
export const APPROVALS_EDIT_SUB =
  "Your changes replace the draft above; nothing is sent until you approve.";

/** The error plate: what failed, and the verb beside it. The body used to add
 *  "Nothing has been approved or denied in the meantime, and nothing expired"
 *  — two clauses of reassurance in front of a member who wants the verb. */
export const APPROVALS_ERROR_TITLE = "Could not reach the consent store";
export const APPROVALS_ERROR_BODY =
  "The gateway answered; the queue that holds staged writes did not.";

/**
 * The status line in ready/full. No inline action: every verb this page offers
 * is attached to the thing it acts on. One clause, as a status line is.
 */
export const APPROVALS_HEALTH_DETAIL =
  "Nothing here has happened yet — approving is the act.";
