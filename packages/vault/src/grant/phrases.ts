// The member-facing vocabulary of a grant's life (#883 V-phrases); the
// gateway's reason prints verbatim, never paraphrased. `withdrawn` is a
// pair, not a word: the copy may not claim a peer dropped what it holds until
// the peer says so, so `remove_sent` is never promoted on a timer.

import type { EnforcementLocus } from "./authority-registry.js";
import { NOTHING_DELIVERED_DETAIL } from "./fulfillment.js";
import type { ShareFulfillmentRecord } from "./grant-store.js";

const GRANT_PHRASES = ["on its way", "shared", "withdrawn"] as const;
export type GrantPhraseName = (typeof GRANT_PHRASES)[number];

export interface GrantPhrase {
  phrase: GrantPhraseName;
  reason: string;
  confirmed?: boolean;
}

function firstDetail(
  fulfillment: readonly ShareFulfillmentRecord[]
): string | undefined {
  for (const row of fulfillment)
    if (row.detail !== null && row.detail !== "") return row.detail;
  return undefined;
}

// An empty `fulfillment` is "no vault addressed yet", not "delivered to none".
export function grantPhrase(input: {
  revokedAt: string | null;
  fulfillment: readonly ShareFulfillmentRecord[];
  locus?: EnforcementLocus;
}): GrantPhrase {
  const rows = input.fulfillment;
  if (input.revokedAt !== null) {
    // `delivered_at`, never `state`, is what says a copy is out there (#846).
    const owed = rows.filter(
      (row) => row.state !== "removed" && row.deliveredAt !== null
    );
    const confirmed = owed.length === 0;
    return {
      phrase: "withdrawn",
      confirmed,
      reason: confirmed
        ? withdrawalConfirmedCopy(input.locus ?? "remote", rows)
        : (firstDetail(owed) ??
          "a vault holding a copy has been asked to remove it and has not yet confirmed"),
    };
  }
  if (rows.length === 0)
    return {
      phrase: "on its way",
      reason: "no vault has been addressed for it yet",
    };
  if (rows.every((row) => row.state === "delivered"))
    return {
      phrase: "shared",
      reason:
        rows.length === 1
          ? "the vault it addresses is holding it"
          : `all ${rows.length} vaults it addresses are holding it`,
    };
  const behind = rows.filter((row) => row.state !== "delivered");
  return {
    phrase: "on its way",
    reason:
      firstDetail(behind) ??
      (behind.every((row) => row.state === "awaiting_channel")
        ? "the link to their vault has ended; nothing new can be delivered"
        : "it is being carried over"),
  };
}

export function revokePromiseCopy(locus: EnforcementLocus): string {
  if (locus === "local")
    return "nothing here will call it again — this vault is the only thing that ever did";
  if (locus === "boundary")
    return "this device is refused at the door from now on; anything already on it stays on it";
  return "their vault is asked to remove its copy; it is no longer shared either way";
}

function withdrawalConfirmedCopy(
  locus: EnforcementLocus,
  fulfillment: readonly ShareFulfillmentRecord[]
): string {
  if (locus !== "remote") return revokePromiseCopy(locus);
  const removed = fulfillment.filter((row) => row.state === "removed");
  // A settled removal clears `delivered_at`, so the detail is the only thing
  // separating "never a copy" from "gone"; `every` on an empty list agrees.
  if (removed.every((row) => row.detail === NOTHING_DELIVERED_DETAIL))
    return "no copy had been delivered — there was nothing to remove";
  return "every copy it delivered has been removed";
}

export function unregisteredVerbCopy(input: {
  subjectType: string;
  verb: string;
  offered: readonly string[];
}): string {
  if (input.offered.length === 0)
    return `${input.subjectType} is not something this vault can share; nothing here could keep that promise true`;
  return `${input.subjectType} can be shared for ${input.offered.join(" or ")}, not for ${input.verb}; nothing here could keep that promise true`;
}

/**
 * The one way to reach a person is a linked account (#903). Two ways to lack
 * one, and they are different facts to a member: never linked, or linked and
 * severed. Both refuse the grant, because a standing answer nothing can carry
 * is not an answer — but only one of them is news.
 */
export function unlinkedAudienceCopy(input: {
  displayName: string;
  severed: boolean;
}): string {
  if (input.severed)
    return `the link to ${input.displayName}'s vault has ended, so there is nowhere to deliver this; link again in People first`;
  return `${input.displayName} has no linked account, and a share is delivered into their vault — link them in People first`;
}

export function verbConflictCopy(input: {
  subjectType: string;
  standingVerb: string;
  verb: string;
}): string {
  return `this is already shared for ${input.standingVerb}; withdraw that first — an answer changed in place could not be audited`;
}
