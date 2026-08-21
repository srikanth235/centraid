/**
 * THE SENTENCES BOTH SEATS SAY ABOUT A GRANT (issue #825).
 *
 * Same shape and same reason as `shared-copy.ts`: one home for the strings the
 * web `GrantSheet.tsx` and the native `kit/share/GrantSheet.tsx` both print, so
 * a fact cannot be described two ways depending on which device is in hand.
 *
 * Two rules from DESIGN.md are load-bearing here:
 *
 *  - The AFTER-revoke sentence is NOT in this file. The route derives it from
 *    what actually happened to each delivered copy and returns it as `message`;
 *    a constant here would paraphrase three honest answers into one optimistic
 *    one. Render that string verbatim.
 *  - The BEFORE-revoke sentence IS here, and it is a destructive confirm — the
 *    one place DESIGN.md allows a full sentence of reassurance. It says the
 *    removal is REQUESTED, because that is all a vault on someone else's
 *    device can be. A confirm that promised the copy was gone would be lying
 *    at exactly the moment a member is deciding.
 */

import type {
  GrantCapability,
  GrantDelivery,
  GrantReach,
} from "./grant-plane.ts";

/** The sheet's own name for the verb. */
export const GRANT_SHEET_TITLE = "Share";

/** Verb-first labels for the capability picker (DESIGN.md: 1–2 words). */
export function capabilityLabel(capability: GrantCapability): string {
  return capability === "edit" ? "Can edit" : "Can view";
}

/**
 * The one place co-contribution is explained, and only for a group: a Tally
 * group shared for edit is the single subject where everyone's writes land in
 * the same tally rather than in their own copy.
 */
export const GROUP_CONTRIBUTION_NOTE =
  "Everyone with edit adds to the same group tally.";

export function groupContributionNote(
  subjectType: string,
  capability: GrantCapability
): string | null {
  return subjectType === "tally.group" && capability === "edit"
    ? GROUP_CONTRIBUTION_NOTE
    : null;
}

/**
 * Where a grant actually got to. `none` is its own sentence: a grant addressed
 * to no vault yet is not a failed delivery and not a delivered one.
 */
export function deliveryLabel(delivery: GrantDelivery): string {
  switch (delivery) {
    case "awaiting_channel":
      return "Invitation pending";
    case "syncing":
      return "Sending";
    case "delivered":
      return "Delivered";
    case "remove_sent":
      return "Removal sent";
    case "removed":
      return "Removed";
    case "none":
      return "Not sent yet";
  }
}

/**
 * How this vault can reach the audience, in the member's terms.
 *
 * `unknown` gets the checking line, not one of the other four: the read has
 * not answered, and "Not reached yet" is a claim about a person that only a
 * read which actually answered may make.
 */
export function reachLabel(reach: GrantReach): string {
  switch (reach) {
    case "live":
      return "Reachable";
    case "invited":
      return "Invitation pending";
    case "severed":
      return "Link ended";
    case "never-reached":
      return "Not reached yet";
    case "unknown":
      return "Checking…";
  }
}

/** One clause under the audience, explaining what its reach costs. */
export function reachNote(reach: GrantReach): string | null {
  switch (reach) {
    case "invited":
      return "Sharing waits here until they join with a vault.";
    case "severed":
      return "The link to their vault ended; nothing new can be delivered.";
    case "never-reached":
      return "Sharing sends an invitation first.";
    case "live":
    case "unknown":
      return null;
  }
}

/** Empty state for an audience nothing stands for yet. */
export function nothingSharedYet(audienceLabel: string): string {
  return `Nothing shared with ${audienceLabel} yet.`;
}

/**
 * An audience this vault has no record of. "We do not know them" and "nothing
 * is shared with them" are two facts, and the second one is a lie about the
 * first — so the 404 gets its own sentence rather than the empty state's.
 */
export function audienceNotKnown(audienceLabel: string): string {
  return `This vault has no record of ${audienceLabel}.`;
}

/** The refusal when the registry answers no capability for a subject type. */
export function subjectNotOfferable(noun: string): string {
  return `A ${noun} cannot be shared as a standing grant.`;
}

/** The one-line outcome after a grant is created, for the status line. */
export function grantedOutcome(
  audienceLabel: string,
  capability: GrantCapability
): string {
  return capability === "edit"
    ? `${audienceLabel} can edit it`
    : `${audienceLabel} can see it`;
}

/** The outcome when the same grant was already standing. */
export function alreadyGrantedOutcome(audienceLabel: string): string {
  return `Already shared with ${audienceLabel}`;
}

/**
 * The outcome when a grant already stands at a DIFFERENT capability.
 *
 * The route answers `exists` and changes nothing, so `alreadyGrantedOutcome`
 * would report the widening the member just asked for as if it had happened.
 * Changing a standing capability would mean revoking and re-granting, which
 * transiently deletes the audience's copy — not a thing to do by accident —
 * so this sentence names the standing access and the move that changes it.
 */
export function capabilityUnchangedOutcome(
  audienceLabel: string,
  standing: GrantCapability
): string {
  const noun = standing === "edit" ? "editing" : "viewing";
  return `Already shared with ${audienceLabel} for ${noun}; changing access is not offered yet — revoke and share again to change it.`;
}

/** The destructive confirm's heading. */
export function revokeConfirmTitle(audienceLabel: string): string {
  return `Stop sharing with ${audienceLabel}?`;
}

/**
 * The destructive confirm's body — the honest best-effort sentence. Removal
 * crosses to a vault this device does not own, so it is ASKED FOR, and the
 * confirm says so before the decision rather than after it.
 */
export function revokeConfirmBody(audienceLabel: string, noun: string): string {
  return `${audienceLabel} loses access to the ${noun}, and their vault is asked to remove its copy.`;
}

/** The destructive confirm's two controls. */
export const REVOKE_CONFIRM_ACTION = "Revoke";
export const REVOKE_CANCEL_ACTION = "Keep sharing";

/** What a failed read or write says when the door gave no message of its own. */
export const GRANTS_UNREADABLE = "Shares could not be read.";

/**
 * The declared registry could not be read. Distinct from `subjectNotOfferable`
 * on purpose: "the vault refuses this subject" and "we could not ask" are two
 * facts, and the refusal is the one a member would act on wrongly.
 */
export const REGISTRY_UNREADABLE = "Shareable items could not be read.";
export const GRANT_FAILED = "The share could not be recorded.";
export const REVOKE_FAILED = "The share could not be revoked.";
