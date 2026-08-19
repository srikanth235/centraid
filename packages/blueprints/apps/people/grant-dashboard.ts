// THE PERSON SCREEN AS THE GRANT DASHBOARD (issue #825, ruling G-audience).
//
// People owns *who*, so "everything Priya can reach" is its question to ask:
// one read, `GET …/grants?partyId=`, through the shared door
// (`_shared/grant-door.ts`). This module is the seat-agnostic half of that —
// the state token a screen draws from, the row words, and the two lists the
// shared `GrantSheet` takes from its host. Both seats import it, so the web
// person screen and the phone's cannot drift into two readings of one answer.
//
// WHAT THIS MODULE REFUSES TO INVENT:
//
//  - A REFUSAL KEEPS THE ROUTE'S OWN SENTENCE. A party this vault has never
//    heard of answers "this vault knows no such person"; a plane that could
//    not be read at all answers the kit's `GRANTS_UNREADABLE`. Neither is ever
//    flattened into "nothing is shared" — that sentence belongs to a read that
//    came back with an empty list.
//  - NO SECOND NOUN TABLE. A grant names its subject by type; the noun a
//    member reads comes from `subjectNoun`, which reads the placement registry
//    every other placement control already reads.
//  - NO SUBJECT NAMES THIS APP DOES NOT HOLD. A grant carries `subject_id` and
//    nothing else, and an id is not a name, so the subjects handed to the
//    sheet carry no `label` — the sheet then reads them by their noun rather
//    than printing an id dressed up as a title.
//
// WHY THE SUBJECTS OFFERED HERE ARE THE ONES ALREADY STANDING: People holds no
// container of its own and the grant plane has no catalog read (subject ids
// are app-polymorphic — `grant-routes.ts` says so at its listing door), so the
// only things this app can honestly name to share are the subjects a standing
// grant already names. From the dashboard that is the real gesture: take
// something this person can already reach and extend it to somebody else. The
// first grant over a new album or document is made where that thing lives.

import { GRANTS_UNREADABLE } from "../_shared/grant-copy.ts";
import { capabilityLabel, deliveryLabel } from "../_shared/grant-copy.ts";
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

/**
 * What the person screen knows about the grant plane right now. The four are
 * different facts and each keeps its own rendering: a read in flight is not an
 * empty list, a host with no grant bridge is not a refused read, and a refusal
 * carries the sentence whoever refused it wrote.
 */
export type PartyGrantsState =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "read"; reach: GrantReach; grants: readonly GrantRecord[] };

/** The one read the dashboard is built from. Live grants only — a revoked
 *  grant is history, not access. */
export async function readPartyGrants(
  door: GrantDoor,
  partyId: string
): Promise<PartyGrantsState> {
  try {
    const answer = await door.forParty(partyId);
    return {
      kind: "read",
      reach: channelReach(answer.channel),
      grants: liveGrants(answer.grants),
    };
  } catch (error) {
    // The route's own words where it sent any: "this vault knows no such
    // person" is a different fact from "shares could not be read", and the
    // member is owed whichever one is true.
    const message = error instanceof Error ? error.message.trim() : "";
    return { kind: "refused", message: message.length ? message : GRANTS_UNREADABLE };
  }
}

/** The noun one grant's row leads with — the registry's, never a wire type. */
export function grantNoun(grant: GrantRecord): string {
  return subjectNoun(grant.subjectType);
}

/** `Can view · since 4 days ago` — the grant row's second line. */
export function grantRowSub(grant: GrantRecord, now = Date.now()): string {
  return LINK.sharedSince(
    capabilityLabel(grant.capability),
    whenLabel(grant.grantedAt, now)
  );
}

/**
 * Where the grant actually got to, in the kit's words. `awaiting_channel`
 * reads as `Invitation pending` — a share to somebody this vault has never
 * reached is waiting, not failing, and nothing here paints it as an error.
 */
export function grantRowMeta(grant: GrantRecord): string {
  return deliveryLabel(grantDelivery(grant));
}

/**
 * The subjects the sheet may offer, deduplicated over the standing grants.
 * No labels: see the module head — an id is not a name.
 */
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

/**
 * The roster as the sheet's audience list — People's own host obligation, and
 * the reason the sheet asks a host for it: this app is where a person has a
 * name. A row with no name is left out rather than offered as an id.
 */
export function partyAudiences(
  people: readonly { party_id: string; name: string }[]
): readonly GrantAudienceOption[] {
  return people.flatMap((person) =>
    person.name.trim().length
      ? [{ kind: "party" as const, id: person.party_id, label: person.name }]
      : []
  );
}
