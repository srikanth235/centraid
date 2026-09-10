// Sharing's cross-surface copy (#805).
//
// The desktop People panel (`react/screens/SharingCard.tsx`, `LinkRow.tsx`)
// and mobile's `screens/Sharing.tsx` + `SharingLinkRow.tsx` say the same thing
// about a link that could not be made.
//
// The string was already inside its budget — an error that names what
// happened, in one clause — so it moved unchanged. A move is not an excuse to
// rewrite copy that is already right.

/** Redeeming a ticket reached nobody. What happened; the retry is the form. */
export const SHARING_UNREACHABLE =
  "That person could not be reached right now.";

// WHAT SHARING SAYS WHEN THE GATEWAY REFUSES (#1015, S14).
//
// These surfaces used to print the transport's own sentence — `mint link
// ticket failed (503)` — which tells a member about an HTTP status and
// nothing about their share. One noun, and the shared retry word; the
// status still reaches the log.
export const SHARING_LINK_NOT_MADE = "Share link not made.";
export const SHARING_CHANGE_NOT_SAVED = "Sharing change not saved.";
