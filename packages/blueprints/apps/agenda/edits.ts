// The two shapes an edit takes on a repeating event, and the one an RSVP
// takes coming back — pure, so the mapping from what the member pressed to
// what the vault is asked is testable without a rendered panel.
//
// Both exist because the mapping is where this app is easiest to get subtly
// wrong: `edit-occurrence` carries a scope AND an action, and the pairing is
// not free — "skip the whole series" is not a thing the product offers, and a
// panel that could express it would be offering a delete under another name.

import type { AgEvent, Attendee, OccurrenceEditPayload } from "./types.ts";

/** The three answers the scope panel offers. */
export type EditScope = "occurrence" | "future" | "series";

/** What the member is doing to the occurrence they opened the panel over. */
export type EditIntent = "edit" | "skip";

/**
 * The `edit-occurrence` payload for one press of the scope panel.
 *
 * SKIP IS AN OCCURRENCE-SHAPED VERB. Skipping "this and following" is how a
 * series is ended early and is offered; skipping "the whole series" would be
 * a deletion wearing a skip's clothes, so the panel refuses it and the caller
 * gets `null` — a control that cannot act is never drawn (spec §"Definition
 * of done"), so this returning `null` is what keeps the button off the panel
 * rather than a disabled button standing there.
 */
export function occurrenceEdit(input: {
  event: Pick<AgEvent, "event_id" | "dtstart" | "original_start">;
  scope: EditScope;
  intent: EditIntent;
  changes?: Pick<OccurrenceEditPayload, "dtstart" | "dtend" | "summary" | "description">;
}): OccurrenceEditPayload | null {
  const { event, scope, intent } = input;
  if (intent === "skip" && scope === "series") return null;
  return {
    event_id: event.event_id,
    // The stable instance identity the vault keys an exception by. A
    // non-recurring row has no `original_start`, and its own start IS the
    // occurrence, so the fallback is the row's own instant rather than an
    // invented key.
    original_start: event.original_start ?? event.dtstart,
    scope,
    action: intent === "skip" ? "skip" : "override",
    ...(intent === "skip" ? {} : (input.changes ?? {})),
  };
}

/** Does this row need the scope panel at all? Only a repeating one does. */
export function needsScopePanel(ev: AgEvent): boolean {
  return Boolean(ev.rrule) || ev.is_recurrence_instance === true;
}

/** The PARTSTAT vocabulary, as the three answers a member gives. */
export type RsvpAnswer = "accepted" | "declined" | "tentative";
export const RSVP_ANSWERS: readonly RsvpAnswer[] = [
  "accepted",
  "declined",
  "tentative",
];

/**
 * The guest list with the owner's own answer already in it.
 *
 * Every write in this product paints immediately, so the answer has to appear
 * in the list the member is looking at before the vault has said anything.
 * This is the projection that does it: same list, one row's `partstat`
 * replaced, nothing else touched — no reordering, no removal, no invented
 * row for an owner who is not on the guest list at all.
 */
export function projectRsvp(
  attendees: readonly Attendee[] | undefined,
  partyId: string,
  partstat: RsvpAnswer
): Attendee[] {
  return (attendees ?? []).map((guest) =>
    guest.party_id === partyId ? { ...guest, partstat } : guest
  );
}

/** The same projection applied to a whole loaded window, so every view showing
 *  that event shows the answer at once. Recurrence instances share a series
 *  id, so all of them move together — which is what the vault will do too. */
export function projectRsvpInto(
  events: readonly AgEvent[],
  eventId: string,
  partyId: string,
  partstat: RsvpAnswer
): AgEvent[] {
  return events.map((ev) =>
    ev.event_id === eventId
      ? { ...ev, attendees: projectRsvp(ev.attendees, partyId, partstat) }
      : ev
  );
}
