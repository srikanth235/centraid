import {
  capabilityLabel,
  GRANTS_UNREACHABLE,
  GRANTS_UNREADABLE,
  grantStandingLabel,
} from "../_shared/grant-copy.ts";
import { isGrantUnreachable } from "../_shared/grant-door.ts";
import type { GrantDoor } from "../_shared/grant-door.ts";
import {
  channelReach,
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

export type PartyGrantsState =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "unknown-party" }
  | { kind: "read"; reach: GrantReach; grants: readonly GrantRecord[] };

export async function readPartyGrants(
  door: GrantDoor,
  partyId: string
): Promise<PartyGrantsState> {
  try {
    const answer = await door.forParty(partyId);
    if (!answer.known) return { kind: "unknown-party" };
    return {
      kind: "read",
      reach: channelReach(answer.channel),
      grants: liveGrants(answer.grants),
    };
  } catch (error) {
    if (isGrantUnreachable(error))
      return { kind: "unavailable", message: GRANTS_UNREACHABLE };
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      kind: "refused",
      message: message.length ? message : GRANTS_UNREADABLE,
    };
  }
}

export function grantNoun(grant: GrantRecord): string {
  return subjectNoun(grant.subjectType);
}

export function grantRowSub(grant: GrantRecord, now = Date.now()): string {
  return LINK.sharedSince(
    capabilityLabel(grant.capability),
    whenLabel(grant.grantedAt, now)
  );
}

export function grantRowMeta(grant: GrantRecord): string {
  return grantStandingLabel(grant) ?? "";
}

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

export function partyAudiences(
  people: readonly { party_id: string; name: string }[]
): readonly GrantAudienceOption[] {
  return people.flatMap((person) =>
    person.name.trim().length
      ? [{ kind: "party" as const, id: person.party_id, label: person.name }]
      : []
  );
}
