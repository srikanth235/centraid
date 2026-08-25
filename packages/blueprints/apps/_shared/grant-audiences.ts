/**
 * Who an app may name in a grant (#825). A grant is addressed to a PARTY,
 * never a vault: drop destinations with no party id, and drop PENDING party
 * ids (nobody yet). Empty is real; a FAILED read is not that answer.
 */

import type { GrantAudienceOption } from "./grant-plane.ts";
import {
  isPendingPartyId,
  readShareCircles,
  readShareDestinations,
} from "./share-kit.ts";

/** Why Share cannot even open. Stated on the control, never after the fact. */
export const NOBODY_TO_SHARE_WITH =
  "There is nobody to share with yet — add someone in People first.";

/** Never "nobody yet" — that would blame the member for a failed read. */
export const ROSTER_UNREADABLE =
  "Your People list could not be read just now — try Share again in a moment.";

/** `pending` is native; web carries the same fact in the id — derived when absent. */
export interface GrantAudienceDestination {
  label: string;
  partyId?: string | undefined;
  pending?: boolean | undefined;
}

export interface GrantAudienceCircle {
  circleId: string;
  label: string;
  members: readonly unknown[];
}

/** People first, then named circles — the order the sheet reads them in. */
export function grantAudiencesFrom(
  destinations: readonly GrantAudienceDestination[],
  circles: readonly GrantAudienceCircle[]
): GrantAudienceOption[] {
  const people = destinations.flatMap<GrantAudienceOption>((destination) => {
    const partyId = destination.partyId;
    if (!partyId) return [];
    const pending = destination.pending ?? isPendingPartyId(partyId);
    return pending
      ? []
      : [{ kind: "party", id: partyId, label: destination.label }];
  });
  const named = circles.map<GrantAudienceOption>((circle) => ({
    kind: "circle",
    id: circle.circleId,
    label: circle.label,
    memberCount: circle.members.length,
  }));
  return [...people, ...named];
}

/** Not read (`null`), read-and-empty (`ok`), or unreadable. */
export type GrantAudienceRead =
  | { readonly ok: true; readonly audiences: GrantAudienceOption[] }
  | { readonly ok: false };

/** Either half failing makes the whole read unreadable. */
export async function readGrantAudiences(): Promise<GrantAudienceRead> {
  try {
    const [destinations, circles] = await Promise.all([
      readShareDestinations(),
      readShareCircles(),
    ]);
    return { ok: true, audiences: grantAudiencesFrom(destinations, circles) };
  } catch {
    return { ok: false };
  }
}
