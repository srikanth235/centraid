/**
 * WHO AN APP MAY NAME IN A GRANT (#825) — the mapping, once.
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
 * every caller states it rather than drawing an empty picker. A read that
 * FAILED is not that answer, and `readGrantAudiences` keeps the two apart:
 * telling a member with a full People directory that they know nobody is a
 * lie the roster's own error was never entitled to tell.
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

/** The OTHER reason the sheet does not open: the roster could not be read at
 *  all. Never "nobody yet" — that would blame the member for a failed read. */
export const ROSTER_UNREADABLE =
  "Your People list could not be read just now — try Share again in a moment.";

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

/**
 * The roster as an ANSWER, which includes "there is no answer". Three states,
 * because a host has three things to say: not read (the caller's own `null`),
 * read and empty (`ok` with no options), and unreadable.
 */
export type GrantAudienceRead =
  | { readonly ok: true; readonly audiences: GrantAudienceOption[] }
  | { readonly ok: false };

/**
 * The web seat's roster, live — and honest about failing. Either half failing
 * makes the whole read unreadable: a roster missing its circles, or its
 * people, is not a roster a member could recognise as their own, and offering
 * the surviving half as if it were complete is how a grant lands on the wrong
 * audience.
 */
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
