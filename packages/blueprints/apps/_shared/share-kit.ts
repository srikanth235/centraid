import type { InlineScope } from "../inline-types.ts";
// Commons picks PEOPLE. A second vault owned by the same person is never a
// member: it syncs through that owner's own topology, outside this roster.
// Locality remains routing, not product semantics.
import { mountedScopes } from "./scope-kit.ts";

/** One person a share could include. Deliberately carries no locality kind. */
export interface ShareDestination {
  id: string;
  label: string;
  /** Explicit identity for a person, including someone who has not joined. */
  partyId?: string;
  /** Absent until an invited person creates and joins with a vault. */
  vaultId?: string;
}

/** A person from the member's own People directory. The host joins this
 * identity to a linked vault when one exists; an absent vault is a real
 * invitation target, not an error or an invented staging location. */
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

/** Turn the independently selected capability on each person row into the
 * exact Commons member array. In particular, an invitation never gets a
 * synthetic vault id. */
export function selectedShareMembers(
  destinations: readonly ShareDestination[],
  selections: Readonly<Record<string, "read" | "read+write">>
): ShareMemberSelection[] {
  return destinations.flatMap((destination) => {
    const capability = selections[destination.id];
    if (!capability) return [];
    // A person queued offline carries an overlay id that no vault has ever
    // settled. Sharing to it would name an identity that does not exist yet,
    // so the row is dropped from the member array rather than sent.
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

export async function loadShareCircles(): Promise<ShareCircle[]> {
  if (!window.centraid.shareCircles) return [];
  try {
    return await window.centraid.shareCircles();
  } catch {
    return [];
  }
}

/** A `window.centraid.links()` row. The label rides ALONG the destination
 *  contract (#750) — it is the linked vault's own name, resolved from the
 *  vault directory by the gateway, not something this sheet reconstructs. */
export interface LinkRow {
  linkId: string;
  vaultId: string;
  partyId: string;
  approved: boolean;
  label?: string | null;
}

/**
 * The human label for a linked vault: the one the LINK carries, resolved from
 * the gateway's vault directory. A truncated vault id is NOT a fallback — an
 * id is not a name, and printing one only ever looked like one. When the
 * directory genuinely holds no name, say so plainly instead. (A vault this
 * member has mounted never reaches here: `linkedDestinations` excludes it, so
 * it is listed once, under its own scope name.)
 */
function linkLabel(link: LinkRow): string {
  return link.label?.trim() ? link.label.trim() : "Linked vault";
}

/** Every APPROVED, non-mounted linked vault — the "linked people" half of
 *  the destination list. Already-mounted destinations (the member's own
 *  vaults) are excluded so nothing appears twice. */
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

/** People-directory targets, preserving invited people whose identity has no
 * vault binding yet. A linked vault already mounted as an own destination is
 * omitted so the same destination never appears twice. */
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

/** An offline write projects a synthetic `pending:<intentId>:<suffix>` id
 * before any vault settles it. Such an id names nobody, so it can never stand
 * in for a person's identity in a share. */
export function isPendingPartyId(partyId: string): boolean {
  return partyId.startsWith("pending:");
}

/** The destination for a person just minted from the sheet itself. The id is
 * synthesized exactly as `peopleDestinations` does for a person with no vault
 * binding, so a later roster reload replaces the row instead of doubling it. */
export function quickAddedDestination(
  partyId: string,
  label: string
): ShareDestination {
  return { id: `party:${partyId}`, label, partyId };
}

/** Append a freshly added person to the listed destinations. Someone already
 * on the list keeps their existing row — the same dedupe-by-party rule
 * `peopleDestinations` applies, so adding a name that is already there is a
 * no-op rather than a second identical person. */
export function withQuickAddedPerson(
  destinations: readonly ShareDestination[],
  added: ShareDestination
): ShareDestination[] {
  const duplicate = destinations.some(
    (destination) =>
      destination.partyId !== undefined && destination.partyId === added.partyId
  );
  return duplicate ? [...destinations] : [...destinations, added];
}

/** Destinations whose label looks like the name being typed, so the sheet can
 * ask "did you mean this person?" before minting a second identity for them.
 * Matching is deliberately loose — equality, or either name containing the
 * other — because a roster spells people out ("Asha Rao") more often than the
 * person typing does. An empty name asks nothing. */
export function nearNameMatches(
  destinations: readonly ShareDestination[],
  name: string
): ShareDestination[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  return destinations.filter((destination) => {
    const label = destination.label.trim().toLowerCase();
    if (!label) return false;
    return label.includes(needle) || needle.includes(label);
  });
}

/**
 * Load the people roster live. Never throws: a transient People read falls
 * back to approved links, and a host with neither answers an empty roster.
 */
export async function loadShareDestinations(
  _currentScopeId: string | null | undefined,
  scopes: readonly InlineScope[] = mountedScopes()
): Promise<ShareDestination[]> {
  if (window.centraid.shareTargets) {
    try {
      return peopleDestinations(await window.centraid.shareTargets(), scopes);
    } catch {
      // Fall through to the older link-only surface. A transient People read
      // must not make an already-linked destination disappear.
    }
  }
  let links: LinkRow[] = [];
  try {
    links = (await window.centraid.links?.()) ?? [];
  } catch {
    links = [];
  }
  return linkedDestinations(links, scopes);
}

/**
 * Why *Share…* cannot even open, or null when it can. Distinct from a
 * per-destination refusal (nowhere to write) — this is "there is nobody to
 * ask at all".
 */
export function shareBlockedReason(
  destinations: readonly ShareDestination[]
): string | null {
  return destinations.length === 0
    ? "There is nobody to share with yet — add someone by name below."
    : null;
}
