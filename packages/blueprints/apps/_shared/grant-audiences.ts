/**
 * WHO AN APP MAY NAME IN A GRANT (issue #825) — the mapping, once.
 *
 * The grant kit draws the sheet; the HOST says who is in the room, because the
 * roster is People's and a sheet that fetched its own audience list would be a
 * second People directory living inside Share. But "turn a roster into
 * `GrantAudienceOption`s" is not a per-app judgment — it is one law, and it
 * lived three times (Docs web, Photos web, the native Docs hook) until this
 * module. Every seat now composes THIS function; only where the roster is read
 * from differs, which is the part that genuinely does differ per seat.
 *
 * Two rules the mapping enforces, because a grant is addressed to a PARTY and
 * never to a vault:
 *
 *  - A destination with no party id names a VAULT, not a person, and is
 *    dropped. The grant plane has nobody to address it to.
 *  - A PENDING party id is an offline overlay no vault has settled
 *    (`isPendingPartyId`, or the native roster's own `pending` flag), so it
 *    names nobody yet. Offering it would record a grant against an identity
 *    that does not exist.
 *
 * An empty answer is a real answer — "there is nobody to share with yet" — and
 * every caller states it rather than drawing an empty picker.
 */

import type { GrantAudienceOption } from "./grant-plane.ts";
import {
  isPendingPartyId,
  loadShareCircles,
  loadShareDestinations,
} from "./share-kit.ts";

/** Why Share cannot even open. Stated on the control, never after the fact. */
export const NOBODY_TO_SHARE_WITH =
  "There is nobody to share with yet — add someone in People first.";

/**
 * One roster row, in the narrowest shape both seats already answer. `pending`
 * is the native roster's own flag; the web roster carries the same fact in the
 * id itself, so it is optional and derived when absent.
 */
export interface GrantAudienceDestination {
  label: string;
  partyId?: string | undefined;
  pending?: boolean | undefined;
}

/** One named circle, in the narrowest shape both seats already answer. */
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

/** The web seat's roster, live. Never throws: both loaders answer empty on a
 *  bad read, which the mapping turns into the honest "nobody yet". */
export async function loadGrantAudiences(): Promise<GrantAudienceOption[]> {
  const [destinations, circles] = await Promise.all([
    loadShareDestinations(null),
    loadShareCircles(),
  ]);
  return grantAudiencesFrom(destinations, circles);
}
