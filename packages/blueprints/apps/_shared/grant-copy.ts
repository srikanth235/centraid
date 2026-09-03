import type {
  GrantCapability,
  GrantPhrase,
  GrantReach,
} from "./grant-plane.ts";

export const GRANT_SHEET_TITLE = "Share";

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

export function grantStandingLabel(grant: {
  phrase?: GrantPhrase;
  confirmed?: boolean;
}): string | null {
  if (!grant.phrase) return null;
  if (grant.phrase === "withdrawn")
    return grant.confirmed === true ? "Withdrawn" : "Withdrawal asked";
  return grant.phrase.charAt(0).toUpperCase() + grant.phrase.slice(1);
}

export function reachLabel(reach: GrantReach): string {
  switch (reach) {
    case "live":
      return "Reachable";
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
    case "severed":
      return "The link to their vault ended; link again in People to share.";
    case "never-reached":
      return "Link their account in People to share with them.";
    case "live":
    case "unknown":
      return null;
  }
}

export function nothingSharedYet(audienceLabel: string): string {
  return `Nothing shared with ${audienceLabel} yet.`;
}

export function notSharedWithAnyoneYet(subjectLabel: string): string {
  return `${subjectLabel} is not shared with anyone yet.`;
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

export function changeAccessConfirmTitle(
  audienceLabel: string,
  capability: GrantCapability
): string {
  return capability === "edit"
    ? `Let ${audienceLabel} edit this?`
    : `Limit ${audienceLabel} to viewing?`;
}

export function changeAccessConfirmBody(noun: string): string {
  return `The ${noun} is withdrawn and shared again at the new access, so their vault is asked to remove its copy and is sent a fresh one.`;
}

export const CHANGE_ACCESS_ACTION = "Change access";
export const CHANGE_ACCESS_CANCEL_ACTION = "Leave it as it is";

export function accessChangedOutcome(
  audienceLabel: string,
  capability: GrantCapability
): string {
  return capability === "edit"
    ? `${audienceLabel} can now edit it`
    : `${audienceLabel} can now only see it`;
}

export function revokeConfirmTitle(audienceLabel: string): string {
  return `Stop sharing with ${audienceLabel}?`;
}

export function revokeConfirmBody(audienceLabel: string, noun: string): string {
  return `${audienceLabel} loses access to the ${noun}, and their vault is asked to remove its copy.`;
}

export const REVOKE_CONFIRM_ACTION = "Revoke";
export const REVOKE_CANCEL_ACTION = "Keep sharing";

export const GRANTS_UNREADABLE = "Shares could not be read.";
export const GRANTS_UNREACHABLE =
  "Shares could not be read — the gateway is out of reach.";

export const REGISTRY_UNREADABLE = "Shareable items could not be read.";
export const REGISTRY_UNREACHABLE =
  "Shareable items are unknown — the gateway is out of reach.";
export const GRANT_FAILED = "The share could not be recorded.";
export const GRANT_AWAITING_CONFIRMATION =
  "The share is recorded as asked and waits for you to confirm it.";
export const GRANT_UNREACHABLE =
  "The share was not sent — the gateway is out of reach.";
export const REVOKE_FAILED = "The share could not be revoked.";
export const REVOKE_UNREACHABLE =
  "The revoke was not sent — the gateway is out of reach.";

function phraseLabel(phrase: GrantPhrase): string {
  return grantStandingLabel({ phrase }) ?? phrase;
}

export const GRANT_QUEUED = `${phraseLabel("on its way")} — this device is offline, so the share is held here and sent when the gateway is reachable.`;

export const REVOKE_QUEUED = `${phraseLabel("on its way")} — this device is offline, so the withdrawal is held here and sent when the gateway is reachable.`;
