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
