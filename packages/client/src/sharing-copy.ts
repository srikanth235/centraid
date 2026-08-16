// Sharing's cross-surface copy (issue #805, slice C).
//
// The desktop People panel (`react/screens/SharingCard.tsx`, `LinkRow.tsx`,
// `SharingRecoveryRows.tsx`) and mobile's `screens/Sharing.tsx` +
// `SharingLinkRow.tsx` say the same four things about a link that could not be
// made and a shared space whose steward went quiet.
//
// Every string here was already inside its budget — an error that names what
// happened, in one clause — so it moved unchanged. A move is not an excuse to
// rewrite copy that is already right.

/** Redeeming a ticket reached nobody. What happened; the retry is the form. */
export const SHARING_UNREACHABLE =
  "That person could not be reached right now.";

/** The pasted invite did not parse as a commons claim. */
export const SHARING_INVALID_INVITE =
  "That shared-space invitation is invalid.";

/** A steward whose history cannot be verified: the seat is parked, and the
 *  recovery ceremony is the only way forward. */
export const SHARING_STEWARD_PARKED =
  "A shared space stopped syncing — its history could not be verified";

/** A steward that is merely quiet. The presence word rides along because
 *  "degraded" and "absent" lead to different verbs. */
export function sharingStewardSilent(presence: string): string {
  return `The device that runs a shared space hasn’t answered (${presence})`;
}

/** How long a steward has been quiet, as a fragment for the meta line. */
export function sharingSilentForDays(days: number): string {
  return `silent for ${days} ${days === 1 ? "day" : "days"}`;
}
