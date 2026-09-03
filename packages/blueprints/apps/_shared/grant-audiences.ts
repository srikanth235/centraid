import type { GrantAudienceOption } from "./grant-plane.ts";
import {
  isPendingPartyId,
  readShareCircles,
  readShareDestinations,
} from "./share-kit.ts";

export const NOBODY_TO_SHARE_WITH =
  "There is nobody to share with yet — add someone in People first.";

export const ROSTER_UNREADABLE =
  "Your People list could not be read just now — try Share again in a moment.";

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

export type GrantAudienceRead =
  | { readonly ok: true; readonly audiences: GrantAudienceOption[] }
  | { readonly ok: false };

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
