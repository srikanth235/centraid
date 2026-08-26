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
