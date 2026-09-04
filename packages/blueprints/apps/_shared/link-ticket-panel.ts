/**
 * The share sheet's link-ticket panel, as state (#929 S6).
 *
 * Both sheets draw it — the browser seat in DOM, the phone in React Native —
 * and neither owns the ceremony. What is shared is the sequence: no ticket, one
 * ticket the member can copy and send, or the door's refusal in its own words.
 * The panel never grants anything and never sends anything; #903's rule that a
 * grant needs a live binding is untouched, and the sheet's submit still
 * refuses until the link is live.
 */

import { useCallback, useEffect, useState } from "react";

import { linkTicketExpiry } from "./grant-copy.ts";
import type { LinkTicketDoor, MintedLinkTicket } from "./grant-plane.ts";

export interface LinkTicketPanel {
  /** `null` until the member asks for one: a ticket is minted on request, not
   *  on render — an unasked ticket is a live credential nobody wanted. */
  ticket: MintedLinkTicket | null;
  /** Read off the ticket at the moment it was minted, so no render reads a
   *  clock: a sentence about time that changes under a re-render is worse
   *  than one that names the moment it was true. */
  expiry: string | null;
  busy: boolean;
  refusal: string | null;
  copied: boolean;
  make: () => Promise<void>;
  noteCopied: () => void;
}

export function useLinkTicket(
  door: LinkTicketDoor | undefined,
  open: boolean
): LinkTicketPanel {
  const [ticket, setTicket] = useState<MintedLinkTicket | null>(null);
  const [expiry, setExpiry] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A closed sheet keeps no ticket: the next opening is a new ask, and a stale
  // one on screen would read as valid long after the gateway expired it.
  useEffect(() => {
    if (open) return;
    // Deferred off the effect body: a synchronous setState here cascades.
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setTicket(null);
      setExpiry(null);
      setRefusal(null);
      setCopied(false);
    });
    return () => {
      active = false;
    };
  }, [open]);

  const make = useCallback(async () => {
    if (!door || busy) return;
    setBusy(true);
    setRefusal(null);
    const outcome = await door();
    setBusy(false);
    if (outcome.ok) {
      setTicket(outcome.ticket);
      setExpiry(linkTicketExpiry(outcome.ticket.expiresAt, Date.now()));
      setCopied(false);
      return;
    }
    setRefusal(outcome.message);
  }, [door, busy]);

  const noteCopied = useCallback(() => setCopied(true), []);

  return { ticket, expiry, busy, refusal, copied, make, noteCopied };
}
