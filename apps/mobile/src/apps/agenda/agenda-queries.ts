/*
 * AGENDA'S READS, AS STATEMENTS (#996 wave 5, R8).
 *
 * Eleven declarative entity requests drew a day: the events themselves, the
 * three tables that decorate them, the roster the RSVPs point at, and the
 * four day-context layers (#834) that are costless facts about a day rather
 * than rows on it. Each is a statement over the seat's own `vault.db` now.
 *
 * THE YEAR-3 WINDOW STAYS A WINDOW. A calendar is a set the member scrolls,
 * and `MOBILE_ENTITY_READ_WINDOW` is the phone's declared ceiling on how much
 * of one it holds at once; `useSeatWindow` reports from the page's own cursor
 * when the rows ran past it, which the old default window swallowed.
 *
 * ORDERED ON THE PRIMARY KEY, because `useAgenda` expands recurrence and sorts
 * the OCCURRENCES — the stored order of the rows is not the order of the day.
 */

import type { PageQuery } from "@centraid/core/page";

const byKey = (column: string): PageQuery["order"] => ({
  sortColumn: column,
  pkColumn: column,
  descending: false,
});

/** One entity's statement, with the row id the overlay and the screens key on. */
export interface AgendaRead {
  query: PageQuery;
  entity: string;
  rowIdColumn: string;
}

export const AGENDA_READS = {
  events: {
    query: {
      name: "phone.agenda.events",
      select:
        "event_id, summary, description, dtstart, dtend, start_tz, end_tz, " +
        "recurrence_semantics, rrule, status, organizer_party_id",
      from: "core_event",
      order: byKey("event_id"),
    },
    entity: "core.event",
    rowIdColumn: "event_id",
  },
  attendees: {
    query: {
      name: "phone.agenda.attendees",
      select: "attendee_id, event_id, party_id, role, partstat, responded_at",
      from: "schedule_attendee",
      order: byKey("attendee_id"),
    },
    entity: "schedule.attendee",
    rowIdColumn: "attendee_id",
  },
  eventExtensions: {
    query: {
      name: "phone.agenda.event-extensions",
      select:
        "event_ext_id, event_id, calendar_id, busy, conferencing_uri, " +
        "reminders_json, travel_buffer_min",
      from: "schedule_event_ext",
      order: byKey("event_ext_id"),
    },
    entity: "schedule.event_ext",
    rowIdColumn: "event_ext_id",
  },
  parties: {
    query: {
      name: "phone.agenda.parties",
      select: "party_id, kind, display_name, sort_name, birth_date",
      from: "core_party",
      order: byKey("party_id"),
    },
    entity: "core.party",
    rowIdColumn: "party_id",
  },
  calendars: {
    query: {
      name: "phone.agenda.calendars",
      select:
        "calendar_id, owner_party_id, name, color, default_tz, visibility",
      from: "schedule_calendar",
      order: byKey("calendar_id"),
    },
    entity: "schedule.calendar",
    rowIdColumn: "calendar_id",
  },
  exceptions: {
    query: {
      name: "phone.agenda.recurrence-exceptions",
      select:
        "exception_id, target_type, target_id, original_start_local, " +
        "recurrence_semantics, scope, action, override_json",
      from: "schedule_recurrence_exception",
      order: byKey("exception_id"),
    },
    entity: "schedule.recurrence_exception",
    rowIdColumn: "exception_id",
  },
  /** The owner party — whose RSVP the owner controls. */
  vault: {
    query: {
      name: "phone.agenda.vault",
      select: "vault_id, self_party_id, display_name",
      from: "core_vault",
      order: byKey("vault_id"),
    },
    entity: "core.vault",
    rowIdColumn: "vault_id",
  },
  tasks: {
    query: {
      name: "phone.agenda.tasks",
      select: "task_id, title, status, due_at, completed_at, owner_party_id",
      from: "schedule_task",
      order: byKey("task_id"),
    },
    entity: "schedule.task",
    rowIdColumn: "task_id",
  },
  tags: {
    query: {
      name: "phone.agenda.tags",
      select: "tag_id, target_type, target_id, concept_id, tagged_at",
      from: "core_tag",
      order: byKey("tag_id"),
    },
    entity: "core.tag",
    rowIdColumn: "tag_id",
  },
  concepts: {
    query: {
      name: "phone.agenda.concepts",
      select: "concept_id, scheme_id, notation, pref_label",
      from: "core_concept",
      order: byKey("concept_id"),
    },
    entity: "core.concept",
    rowIdColumn: "concept_id",
  },
  schemes: {
    query: {
      name: "phone.agenda.concept-schemes",
      select: "scheme_id, uri, title",
      from: "core_concept_scheme",
      order: byKey("scheme_id"),
    },
    entity: "core.concept_scheme",
    rowIdColumn: "scheme_id",
  },
} satisfies Record<string, AgendaRead>;
