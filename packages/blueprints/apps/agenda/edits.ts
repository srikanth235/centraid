// Edit-scope mapping for a repeating event, and RSVP projection.
// "Skip the whole series" is not offered.

import type { AgEvent, Attendee, OccurrenceEditPayload } from "./types.ts";

export type EditScope = "occurrence" | "future" | "series";

export type EditIntent = "edit" | "skip";

/**
 * Skip is occurrence-shaped: skip+series returns `null` so the button is
 * not drawn (spec: a control that cannot act is never drawn).
 */
export function occurrenceEdit(input: {
  event: Pick<AgEvent, "event_id" | "dtstart" | "original_start">;
  scope: EditScope;
  intent: EditIntent;
  changes?: Pick<
    OccurrenceEditPayload,
    | "dtstart"
    | "dtend"
    | "summary"
    | "description"
    | "recurrence_semantics"
    | "calendar_id"
    | "reminders"
    | "conferencing_uri"
    | "attendee_party_ids"
  >;
}): OccurrenceEditPayload | null {
  const { event, scope, intent } = input;
  if (intent === "skip" && scope === "series") return null;
  return {
    event_id: event.event_id,
    // A non-recurring row has no `original_start`; its own start IS the occurrence.
    original_start: event.original_start ?? event.dtstart,
    scope,
    action: intent === "skip" ? "skip" : "override",
    ...(intent === "skip" ? {} : (input.changes ?? {})),
  };
}

export function needsScopePanel(ev: AgEvent): boolean {
  return Boolean(ev.rrule) || ev.is_recurrence_instance === true;
}

export type RsvpAnswer = "accepted" | "declined" | "tentative";
export const RSVP_ANSWERS: readonly RsvpAnswer[] = [
  "accepted",
  "declined",
  "tentative",
];

/**
 * Same list, one row's `partstat` replaced — no invented row for an owner
 * who is not on the guest list.
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

/** Recurrence instances share a series id, so all of them move. */
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
