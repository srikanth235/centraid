/**
 * THE WEB SEAT'S TRANSPORT into the grant plane (#825).
 *
 * A blueprint app cannot fetch a gateway path itself: the shell's document
 * origin is not the gateway (the installable PWA rides the iroh tunnel, the
 * desktop shell runs from `file://`), so the credential and the route both
 * live on the host bridge. This module is the whole of that seat difference —
 * everything downstream is `grant-door.ts`, shared with native.
 *
 * FEATURE-DETECTED, like every other optional bridge method. An older shell
 * that predates the grant plane answers "sharing is not available on this
 * host" rather than throwing an undefined-call stack at a member.
 */

import { grantDoor } from "./grant-door.ts";
import type { GrantDoor, GrantWireCalls } from "./grant-door.ts";
import { parseMintedLinkTicket } from "./grant-plane.ts";
import type { LinkTicketDoor } from "./grant-plane.ts";

/** What a host with no grant bridge says. One clause, and it names the fix. */
export const GRANTS_UNAVAILABLE_HERE =
  "Sharing needs a newer gateway connection.";

export function grantPlaneAvailable(): boolean {
  return typeof window.centraid?.grants?.create === "function";
}

function bridge(): NonNullable<typeof window.centraid.grants> {
  const grants = window.centraid?.grants;
  if (!grants) throw new Error(GRANTS_UNAVAILABLE_HERE);
  return grants;
}

export function webGrantCalls(): GrantWireCalls {
  return {
    subjects: () => bridge().subjects(),
    forParty: (partyId) => bridge().forParty(partyId),
    forAudience: (kind, id) => bridge().forAudience(kind, id),
    forSubject: (subjectType, subjectId) =>
      bridge().forSubject(subjectType, subjectId),
    create: (request) => bridge().create(request),
    revoke: (grantId) => bridge().revoke(grantId),
  };
}

export function webGrantDoor(): GrantDoor {
  return grantDoor(webGrantCalls());
}

/** What a host too old to mint a ticket says — one clause naming the fix, the
 *  same shape `GRANTS_UNAVAILABLE_HERE` uses. */
export const LINK_TICKET_UNAVAILABLE_HERE =
  "Making a link ticket needs a newer gateway connection.";

/**
 * The web seat's link-ticket door (#929 S6). Feature-detected like every other
 * optional bridge method, and it reads no payload itself: the wire guard lives
 * once in `grant-plane.ts`, shared with the native seat.
 */
export function webLinkTicketDoor(): LinkTicketDoor {
  return async () => {
    const mint = window.centraid?.linkTicket;
    if (typeof mint !== "function")
      return { ok: false, message: LINK_TICKET_UNAVAILABLE_HERE };
    try {
      const ticket = parseMintedLinkTicket(await mint());
      return ticket
        ? { ok: true, ticket }
        : { ok: false, message: LINK_TICKET_UNAVAILABLE_HERE };
    } catch (error) {
      // The route's own words, which the sheet prints verbatim.
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
