// The seat-agnostic half of the person screen's grant dashboard (#825, ruling
// G-audience). Both seats import it; neither may re-read the one answer.
//
// INVENT NOTHING HERE: never flatten "no such person" or `GRANTS_UNREADABLE`
// into "nothing is shared"; take nouns from `subjectNoun`, not a second table;
// give subjects no labels, since a grant carries only an id. Offer only
// subjects a standing grant already names — People holds no container and the
// grant plane has no catalog read.

import {
  capabilityLabel,
  deliveryLabel,
  GRANTS_UNREADABLE,
} from "../_shared/grant-copy.ts";
import type { GrantDoor } from "../_shared/grant-door.ts";
import {
  channelReach,
  grantDelivery,
  liveGrants,
  subjectNoun,
} from "../_shared/grant-plane.ts";
import type {
  GrantAudienceOption,
  GrantReach,
  GrantRecord,
  GrantSubject,
} from "../_shared/grant-plane.ts";
import { whenLabel } from "./format.ts";
import { LINK } from "./people-copy.ts";

/** Every variant is a distinct fact with its own rendering. */
export type PartyGrantsState =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "refused"; message: string }
  /** No record of the party — not the same as nothing shared. */
  | { kind: "unknown-party" }
  | { kind: "read"; reach: GrantReach; grants: readonly GrantRecord[] };

/** Live grants only: a revoked grant is history, not access. */
export async function readPartyGrants(
  door: GrantDoor,
  partyId: string
): Promise<PartyGrantsState> {
  try {
    const answer = await door.forParty(partyId);
    // The 404. Never read it as "nothing is shared with them".
    if (!answer.known) return { kind: "unknown-party" };
    return {
      kind: "read",
      reach: channelReach(answer.channel),
      grants: liveGrants(answer.grants),
    };
  } catch (error) {
    // Keep the route's own words where it sent any.
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      kind: "refused",
      message: message.length ? message : GRANTS_UNREADABLE,
    };
  }
}

/** The registry's noun, never a wire type. */
export function grantNoun(grant: GrantRecord): string {
  return subjectNoun(grant.subjectType);
}

export function grantRowSub(grant: GrantRecord, now = Date.now()): string {
  return LINK.sharedSince(
    capabilityLabel(grant.capability),
    whenLabel(grant.grantedAt, now)
  );
}

/** `awaiting_channel` is waiting, not failing; never paint it as an error. */
export function grantRowMeta(grant: GrantRecord): string {
  return deliveryLabel(grantDelivery(grant));
}

/** No labels: an id is not a name (see the module head). */
export function grantSubjects(
  grants: readonly GrantRecord[]
): readonly GrantSubject[] {
  const seen = new Set<string>();
  const subjects: GrantSubject[] = [];
  for (const grant of grants) {
    const key = `${grant.subjectType}:${grant.subjectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    subjects.push({
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
    });
  }
  return subjects;
}

/** A nameless row is left out rather than offered as an id. */
export function partyAudiences(
  people: readonly { party_id: string; name: string }[]
): readonly GrantAudienceOption[] {
  return people.flatMap((person) =>
    person.name.trim().length
      ? [{ kind: "party" as const, id: person.party_id, label: person.name }]
      : []
  );
}
