// The native seat's half of the grant transport — only the base URL and this
// phone's own device credential differ from the browser seat's (#883).

import { grantDoor } from "@centraid/blueprints/apps/_shared/grant-door";
import type { GrantDoor } from "@centraid/blueprints/apps/_shared/grant-door";
import { parseMintedLinkTicket } from "@centraid/blueprints/apps/_shared/grant-plane";
import type { LinkTicketDoor } from "@centraid/blueprints/apps/_shared/grant-plane";
import {
  grantWireCalls,
  queuedGrantWireCalls,
} from "@centraid/blueprints/apps/_shared/grant-transport";
import type {
  GrantHttp,
  GrantIntentQueue,
  QueuedGrantWireCalls,
} from "@centraid/blueprints/apps/_shared/grant-transport";

import { apiHeaders } from "../../lib/gateway";
import { mintLinkTicket } from "../../lib/replica/links-transport";
import { nativeGrantIntentQueue } from "./grant-queue-store";

export function nativeGrantHttp(baseUrl: string): GrantHttp {
  return {
    get: (pathname) =>
      fetch(new URL(pathname, baseUrl), { headers: apiHeaders() }),
    post: (pathname, payload) =>
      fetch(new URL(pathname, baseUrl), {
        method: "POST",
        headers: apiHeaders(
          payload === undefined ? {} : { "content-type": "application/json" }
        ),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
  };
}

/** The offline queue sits in front of the two writes. */
export function nativeGrantDoor(
  baseUrl: string,
  queue: GrantIntentQueue = nativeGrantIntentQueue()
): GrantDoor {
  return grantDoor(nativeGrantWire(baseUrl, queue));
}

export function nativeGrantWire(
  baseUrl: string,
  queue: GrantIntentQueue = nativeGrantIntentQueue()
): QueuedGrantWireCalls {
  return queuedGrantWireCalls(grantWireCalls(nativeGrantHttp(baseUrl)), queue);
}

/** What the phone says when it has no vault or no gateway to mint against. */
export const LINK_TICKET_UNAVAILABLE_HERE =
  "Connect this phone to your gateway to make a link ticket.";

/**
 * The phone's link-ticket door (#929 S6) — the same `peer_link_tickets`
 * ceremony `SharingLinkRow` uses, reached from the share sheet so an unlinked
 * person is not a dead end. It reads no payload itself: the wire guard lives
 * once in `_shared/grant-plane.ts`, shared with the browser seat.
 */
export function nativeLinkTicketDoor(
  baseUrl: string,
  vaultId: string | undefined
): LinkTicketDoor {
  return async () => {
    if (!baseUrl || !vaultId)
      return { ok: false, message: LINK_TICKET_UNAVAILABLE_HERE };
    try {
      const ticket = parseMintedLinkTicket(
        await mintLinkTicket(baseUrl, vaultId)
      );
      return ticket
        ? { ok: true, ticket }
        : { ok: false, message: LINK_TICKET_UNAVAILABLE_HERE };
    } catch (error) {
      // The gateway's own words, which the sheet prints verbatim.
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
