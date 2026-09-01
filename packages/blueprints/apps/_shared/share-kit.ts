// The Commons share plane picks PEOPLE: an own second vault is never a member.
import type { InlineScope } from "../inline-types.ts";
import { mountedScopes } from "./scope-kit.ts";

export interface ShareDestination {
  id: string;
  label: string;
  partyId?: string;
  vaultId?: string;
}

export interface ShareTarget {
  partyId: string;
  label: string;
  vaultId?: string;
}

export interface ShareCircle {
  circleId: string;
  label: string;
  members: ShareMemberSelection[];
}

export interface ShareMemberSelection {
  partyId?: string;
  vaultId?: string;
  capability: "read" | "read+write";
}

/** An invitation never gets a synthetic vault id. */
export function selectedShareMembers(
  destinations: readonly ShareDestination[],
  selections: Readonly<Record<string, "read" | "read+write">>
): ShareMemberSelection[] {
  return destinations.flatMap((destination) => {
    const capability = selections[destination.id];
    if (!capability) return [];
    if (destination.partyId && isPendingPartyId(destination.partyId)) return [];
    return [
      {
        ...(destination.partyId ? { partyId: destination.partyId } : {}),
        ...(destination.vaultId ? { vaultId: destination.vaultId } : {}),
        capability,
      },
    ];
  });
}

export function selectionsForCircle(
  destinations: readonly ShareDestination[],
  circle: ShareCircle
): Record<string, "read" | "read+write"> {
  const capabilityByParty = new Map(
    circle.members.flatMap((member) =>
      member.partyId ? [[member.partyId, member.capability] as const] : []
    )
  );
  return Object.fromEntries(
    destinations.flatMap((destination) => {
      const capability = destination.partyId
        ? capabilityByParty.get(destination.partyId)
        : undefined;
      return capability ? [[destination.id, capability]] : [];
    })
  );
}

export interface LinkRow {
  linkId: string;
  vaultId: string;
  partyId: string;
  approved: boolean;
  label?: string | null;
}

/** A truncated vault id is not a fallback — an id is not a name. */
function linkLabel(link: LinkRow): string {
  return link.label?.trim() ? link.label.trim() : "Linked vault";
}

export function linkedDestinations(
  links: readonly LinkRow[],
  scopes: readonly InlineScope[]
): ShareDestination[] {
  const mounted = new Set(scopes.map((scope) => scope.id));
  return links
    .filter((link) => link.approved && !mounted.has(link.vaultId))
    .map((link) => ({
      id: link.vaultId,
      label: linkLabel(link),
      partyId: link.partyId,
      vaultId: link.vaultId,
    }));
}

/** Keeps vault-less invitees; drops mounted ones (no duplicates). */
export function peopleDestinations(
  people: readonly ShareTarget[],
  scopes: readonly InlineScope[]
): ShareDestination[] {
  const mounted = new Set(scopes.map((scope) => scope.id));
  const seen = new Set<string>();
  return people.flatMap((person) => {
    if (!person.partyId || seen.has(person.partyId)) return [];
    seen.add(person.partyId);
    if (person.vaultId && mounted.has(person.vaultId)) return [];
    return [
      {
        id: person.vaultId ?? `party:${person.partyId}`,
        label: person.label,
        partyId: person.partyId,
        ...(person.vaultId ? { vaultId: person.vaultId } : {}),
      },
    ];
  });
}

/** Names nobody until a vault settles it. */
export function isPendingPartyId(partyId: string): boolean {
  return partyId.startsWith("pending:");
}

/** A read throws rather than answering empty (#883): the link fallback is
 *  feature detection, never failure handling. */
export async function readShareDestinations(
  scopes: readonly InlineScope[] = mountedScopes()
): Promise<ShareDestination[]> {
  if (window.centraid.shareTargets) {
    return peopleDestinations(await window.centraid.shareTargets(), scopes);
  }
  return linkedDestinations((await window.centraid.links?.()) ?? [], scopes);
}

export async function readShareCircles(): Promise<ShareCircle[]> {
  if (!window.centraid.shareCircles) return [];
  return await window.centraid.shareCircles();
}
