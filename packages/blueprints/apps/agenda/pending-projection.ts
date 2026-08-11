// Agenda's pending-write projection (issue #738) — pure config, scope-kit
// style, consumed by `createPendingOverlayModel` in logic.ts. Each function
// projects one write action into the rows agenda's queries actually read
// (queries/upcoming.ts, queries/search.ts): `core.event` and
// `schedule.attendee`, both already consented read scopes (app.json). Only
// schema columns ride along — `is_recurrence_instance`, `instance_key` and
// every other computed field are the query's job, never the overlay's.
import type { PendingProjectionDeclaration } from "../_shared/pending-overlay.ts";

/** Scalar fields `propose`/`edit-event` may carry straight onto `core.event`. */
const EVENT_TEXT_FIELDS = [
  "summary",
  "dtstart",
  "dtend",
  "start_tz",
  "end_tz",
  "recurrence_semantics",
  "rrule",
  "description",
  "location_place_id",
] as const;

function stringField(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export const agendaPendingProjection: PendingProjectionDeclaration = {
  appId: "agenda",
  actions: {
    // Mirrors schedule.propose_event's INSERT (packages/vault/src/commands/
    // schedule.ts): a new tentative core.event row under the minted id.
    // attendee/calendar edges are left to settlement — several sub-rows for
    // one create is more surface than this projection needs to earn its keep.
    propose(input, ctx) {
      const values: Record<string, unknown> = {
        event_id: ctx.rowId,
        status: "tentative",
        sequence: 0,
      };
      for (const field of EVENT_TEXT_FIELDS) {
        const value = stringField(input, field);
        if (value !== undefined) values[field] = value;
      }
      return [{ op: "upsert", entity: "core.event", rowId: ctx.rowId, values }];
    },

    // The exact mutation respondRsvp used to build inline: an attendee's
    // PARTSTAT is keyed by its OWN row (schedule.attendee), never the event —
    // the write's `input` carries `attendee_id` alongside the command's own
    // `event_id`/`party_id`/`partstat` fields (an optional, ignored-by-the-
    // command property; app.json declares it so the schema accepts it) purely
    // so this pure function can name the row it is editing.
    rsvp(input) {
      const attendeeId = stringField(input, "attendee_id");
      const partstat = stringField(input, "partstat");
      if (!attendeeId || !partstat) return [];
      return [
        {
          op: "upsert",
          entity: "schedule.attendee",
          rowId: attendeeId,
          values: { partstat, responded_at: new Date().toISOString() },
        },
      ];
    },

    // schedule.cancel_event flips status only; SEQUENCE is a settlement
    // detail no view renders.
    "cancel-event"(input) {
      const eventId = stringField(input, "event_id");
      if (!eventId) return [];
      return [
        {
          op: "upsert",
          entity: "core.event",
          rowId: eventId,
          values: { status: "cancelled" },
        },
      ];
    },

    // schedule.edit_event's own field-by-field UPDATE (schedule-organize.ts),
    // restated as an upsert: only fields present in the payload move,
    // `clear_*` flags null their column. Attendee-roster replacement is not
    // projected — it deletes and re-inserts unkeyed rows the overlay has no
    // stable id for.
    "edit-event"(input) {
      const eventId = stringField(input, "event_id");
      if (!eventId) return [];
      const values: Record<string, unknown> = {};
      for (const field of EVENT_TEXT_FIELDS) {
        const value = stringField(input, field);
        if (value !== undefined) values[field] = value;
      }
      if (input.clear_description === true) values.description = null;
      if (input.clear_rrule === true) values.rrule = null;
      if (input.clear_location === true) values.location_place_id = null;
      if (Object.keys(values).length === 0) return [];
      return [{ op: "upsert", entity: "core.event", rowId: eventId, values }];
    },

    // schedule.edit_event_occurrence branches by scope (schedule-organize.ts
    // editOccurrence): only `scope: "series"` lands on core.event directly —
    // "occurrence"/"future" store a schedule.recurrence_exception row the
    // read-time rrule expansion interprets, which this overlay cannot
    // honestly replay without reimplementing that expansion.
    "edit-occurrence"(input) {
      if (input.scope !== "series") return [];
      const eventId = stringField(input, "event_id");
      if (!eventId) return [];
      if (input.action === "skip") {
        return [
          {
            op: "upsert",
            entity: "core.event",
            rowId: eventId,
            values: { status: "cancelled" },
          },
        ];
      }
      const values: Record<string, unknown> = {};
      for (const field of ["dtstart", "dtend", "summary", "description"]) {
        const value = stringField(input, field);
        if (value !== undefined) values[field] = value;
      }
      if (Object.keys(values).length === 0) return [];
      return [{ op: "upsert", entity: "core.event", rowId: eventId, values }];
    },
  },
};
