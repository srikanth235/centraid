// Grant sentences both seats print (#825). The AFTER-revoke sentence is not
// here: the route derives it per copy and returns `message` — render it as is.

import type {
  GrantCapability,
  GrantPhrase,
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

/**
 * Sentence-cases the vault's own phrase (#883, ruling V-phrases) — never a
 * label table re-derived from fulfillment rows. Unconfirmed `withdrawn` reads
 * as asked, not completed. No phrase on the wire gives `null`.
 */
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
    // Not "an invitation goes out first" — since #903 nothing is sent, and a
    // note promising an act the sheet will not perform is worse than silence.
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

/* A standing answer is never edited in place (#883, ruling V-table): a change
 * is a withdrawal then a new grant, so the audience's copy is asked back. The
 * confirm says so first; the action is worded as the change, not the mechanism. */

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

/** Removal crosses to a vault this device does not own, so it is ASKED FOR. */
export function revokeConfirmBody(audienceLabel: string, noun: string): string {
  return `${audienceLabel} loses access to the ${noun}, and their vault is asked to remove its copy.`;
}

export const REVOKE_CONFIRM_ACTION = "Revoke";
export const REVOKE_CANCEL_ACTION = "Keep sharing";

/* REFUSED IS NOT UNREACHABLE (#880). `_FAILED`/`_UNREADABLE` are the gateway's
 * own half: nothing it says may be replaced with a network story.
 * `_UNREACHABLE` is the transport's half — no answer exists, so none is put in
 * the gateway's mouth. `grant-door.ts` picks by transport fact. */

export const GRANTS_UNREADABLE = "Shares could not be read.";
export const GRANTS_UNREACHABLE =
  "Shares could not be read — the gateway is out of reach.";

export const REGISTRY_UNREADABLE = "Shareable items could not be read.";
export const REGISTRY_UNREACHABLE =
  "Shareable items are unknown — the gateway is out of reach.";
export const GRANT_FAILED = "The share could not be recorded.";
/** Only where the route sent no words of its own for its own 202. */
export const GRANT_AWAITING_CONFIRMATION =
  "The share is recorded as asked and waits for you to confirm it.";
export const GRANT_UNREACHABLE =
  "The share was not sent — the gateway is out of reach.";
export const REVOKE_FAILED = "The share could not be revoked.";
export const REVOKE_UNREACHABLE =
  "The revoke was not sent — the gateway is out of reach.";

/* HELD, NOT LOST (#883): a seat that holds the intent durably tells a
 * different truth from `_UNREACHABLE` above, which recorded nothing. Built
 * from the wire's own `on its way` rather than a fourth word for the state. */

function phraseLabel(phrase: GrantPhrase): string {
  // Null only where the wire carried no phrase; a named one always labels.
  return grantStandingLabel({ phrase }) ?? phrase;
}

export const GRANT_QUEUED = `${phraseLabel("on its way")} — this device is offline, so the share is held here and sent when the gateway is reachable.`;

export const REVOKE_QUEUED = `${phraseLabel("on its way")} — this device is offline, so the withdrawal is held here and sent when the gateway is reachable.`;
