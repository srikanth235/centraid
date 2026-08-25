// One home for the grant sentences both seats print (#825). The AFTER-revoke
// sentence is NOT here — the route derives it per delivered copy and returns
// it as `message`; render that verbatim.

import type {
  GrantCapability,
  GrantDelivery,
  GrantReach,
} from "./grant-plane.ts";

export const GRANT_SHEET_TITLE = "Share";

/** Verb-first, 1–2 words (DESIGN.md). */
export function capabilityLabel(capability: GrantCapability): string {
  return capability === "edit" ? "Can edit" : "Can view";
}

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

export function nothingSharedYet(audienceLabel: string): string {
  return `Nothing shared with ${audienceLabel} yet.`;
}

export function audienceNotKnown(audienceLabel: string): string {
  return `This vault has no record of ${audienceLabel}.`;
}

export function subjectNotOfferable(noun: string): string {
  return `A ${noun} cannot be shared as a standing grant.`;
}

export function grantedOutcome(
  audienceLabel: string,
  capability: GrantCapability
): string {
  return capability === "edit"
    ? `${audienceLabel} can edit it`
    : `${audienceLabel} can see it`;
}

export function alreadyGrantedOutcome(audienceLabel: string): string {
  return `Already shared with ${audienceLabel}`;
}

/** The route answers `exists` and changes nothing; widening means revoke and
 *  re-grant, which transiently deletes the audience's copy. */
export function capabilityUnchangedOutcome(
  audienceLabel: string,
  standing: GrantCapability
): string {
  const noun = standing === "edit" ? "editing" : "viewing";
  return `Already shared with ${audienceLabel} for ${noun}; changing access is not offered yet — revoke and share again to change it.`;
}

export function revokeConfirmTitle(audienceLabel: string): string {
  return `Stop sharing with ${audienceLabel}?`;
}

/** Removal crosses to a vault this device does not own, so it is ASKED FOR. */
export function revokeConfirmBody(audienceLabel: string, noun: string): string {
  return `${audienceLabel} loses access to the ${noun}, and their vault is asked to remove its copy.`;
}

export const REVOKE_CONFIRM_ACTION = "Revoke";
export const REVOKE_CANCEL_ACTION = "Keep sharing";

export const GRANTS_UNREADABLE = "Shares could not be read.";

export const REGISTRY_UNREADABLE = "Shareable items could not be read.";
export const GRANT_FAILED = "The share could not be recorded.";
export const REVOKE_FAILED = "The share could not be revoked.";
