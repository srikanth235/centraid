// WHO A PENDING WRITE IS WAITING ON (#929). A member's write to a shared
// container is executed by the ORIGIN, so a queued one waits for that vault's
// owner — and the seat renders a PERSON, taken from the link's own label.
//
// The label the origin sends rides on `IntentOutcome.waitingOn`; this is the
// phone's answer BEFORE any reply, from the mount it already holds, so the
// pending row never has to say "waiting" with no one named.

/** What a member reads when the link carries no label to name. */
export const UNNAMED_ORIGIN_LABEL = "the owner's device";

/** Present means the member does NOT own this container, so a write may wait. */
export interface MountedOrigin {
  displayName?: string;
}

/** Whitespace is collapsed first: a name with a line break is still one line. */
export function waitingOnLabel(displayName?: string): string {
  const label = (displayName ?? "").trim().replace(/\s+/gu, " ");
  if (!label) return UNNAMED_ORIGIN_LABEL;
  const possessive = /['’]s$/iu.test(label)
    ? label
    : /['’]$/u.test(label)
      ? `${label}s`
      : `${label}'s`;
  return `${possessive} device`;
}
