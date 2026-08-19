/**
 * WHO DOCS CAN NAME IN A GRANT (issue #825).
 *
 * The share kit draws the sheet; the ROSTER is the host's obligation, because
 * People is not the kit's to read — an app that let the sheet fetch its own
 * audience list would be a second People directory living inside Share. Docs
 * therefore hands the sheet exactly what its own seat already knows: the
 * people this vault can reach, then the named circles it has.
 *
 * Two rules the list keeps, both of them absent-never-empty:
 *
 *  - A PENDING person is not offered. An offline write projects a
 *    `pending:<intentId>` party id that no vault has settled; naming one in a
 *    grant would address an identity that does not exist yet.
 *  - An EMPTY roster is a real answer, not a failure. `loadShareDestinations`
 *    never throws — a host with no People surface answers "nobody yet", and
 *    the sheet says so rather than showing a spinner forever.
 */

import type { GrantAudienceOption } from "../_shared/grant-plane.ts";
import {
  isPendingPartyId,
  loadShareCircles,
  loadShareDestinations,
} from "../_shared/share-kit.ts";

/**
 * What Docs must hold before it may draw Share at all: a roster that has been
 * READ (an empty one is "nobody yet"; an unread one is not an answer), and the
 * app's one status line. Absent where this host has no grant plane to reach,
 * so a seat that cannot share offers no affordance rather than a dead button.
 */
export interface DocsShareHost {
  audiences: readonly GrantAudienceOption[];
  onStatus: (message: string) => void;
}

/** People first, then named circles — the order the sheet reads them in. */
export function grantAudiencesFrom(
  destinations: readonly { label: string; partyId?: string }[],
  circles: readonly { circleId: string; label: string; members: unknown[] }[]
): GrantAudienceOption[] {
  const people = destinations.flatMap((destination) =>
    destination.partyId && !isPendingPartyId(destination.partyId)
      ? [
          {
            kind: "party" as const,
            id: destination.partyId,
            label: destination.label,
          },
        ]
      : []
  );
  const groups = circles.map((circle) => ({
    kind: "circle" as const,
    id: circle.circleId,
    label: circle.label,
    memberCount: circle.members.length,
  }));
  return [...people, ...groups];
}

/** The roster this seat can offer, read live. Never throws. */
export async function loadGrantAudiences(): Promise<GrantAudienceOption[]> {
  const [destinations, circles] = await Promise.all([
    loadShareDestinations(null),
    loadShareCircles(),
  ]);
  return grantAudiencesFrom(destinations, circles);
}
