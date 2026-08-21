// The Agenda read layer — the calendar projected from THIS DEVICE's
// consent-shaped replica, exactly the entity set the `agenda` manifest's read
// scopes grant (packages/blueprints/apps/agenda/app.json).
//
// One `useReplicaQuery` per entity, one combined honesty state, one memoized
// expansion. The expansion engine is the SHARED one
// (`kit/schedule/recurrence.ts` `expandEvent`) — there is one recurrence
// grammar in this product and the phone reads it rather than growing a second.

import { useMemo } from "react";

import type { ReplicaRow } from "@centraid/client/replica/native";

import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import type { AgendaEventModel } from "../../kit/schedule/recurrence";
import { expandEvent } from "../../kit/schedule/recurrence";
import { starredParties } from "./day-context";

const value = <T>(row: ReplicaRow, key: string): T | undefined =>
  row[key] as T | undefined;

/** One expanded occurrence, carrying the canonical row it came from so the
 *  held-write overlay can be read off it without a second lookup. */
export type NativeAgendaEvent = AgendaEventModel & { raw: ReplicaRow };

function useAgendaEntity(entity: string) {
  return useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity }), [entity])
  );
}

export function useAgenda(rangeStart: Date, rangeEnd: Date) {
  const events = useAgendaEntity("core.event");
  const attendees = useAgendaEntity("schedule.attendee");
  const eventExtensions = useAgendaEntity("schedule.event_ext");
  const parties = useAgendaEntity("core.party");
  const calendars = useAgendaEntity("schedule.calendar");
  const exceptions = useAgendaEntity("schedule.recurrence_exception");
  // The vault's owner party — the one attendee whose RSVP the owner controls.
  // `core.vault` is granted to the agenda shape, so this rides the same
  // offline replica as everything else.
  const vault = useAgendaEntity("core.vault");
  // THE DAY-CONTEXT LAYERS (#834). Costless facts that decorate a day and
  // never become a row: the member's own open tasks coming due, and the
  // starred-flag vocabulary that answers a birthday's relationship tier.
  // `core.party` is already read above for the guest list. Every entity here
  // is inside Agenda's declared read scopes, and this seat's replica holds the
  // member's OWN rows — which is what makes the shelf obey R-shelf-scope
  // without a scope argument of its own.
  const tasks = useAgendaEntity("schedule.task");
  const tags = useAgendaEntity("core.tag");
  const concepts = useAgendaEntity("core.concept");
  const schemes = useAgendaEntity("core.concept_scheme");

  const queryState = combineReplicaQueryStates([
    events,
    attendees,
    eventExtensions,
    parties,
    calendars,
    exceptions,
    vault,
  ]);

  const rows = useMemo(
    () =>
      events.rows
        .flatMap((row) => {
          const id = value<string>(row, "event_id");
          const start = value<string>(row, "dtstart");
          if (!id || !start || value(row, "status") === "cancelled") return [];
          // The vault allows a NULL dtend and treats it as a zero-duration
          // event (queries/upcoming.ts); match that rather than dropping the
          // row and leaving a real commitment invisible.
          const end = value<string>(row, "dtend") ?? start;
          const extension = eventExtensions.rows.find(
            (candidate) => value(candidate, "event_id") === id
          );
          return expandEvent(
            {
              id,
              calendarId: value<string>(extension ?? row, "calendar_id"),
              summary: value<string>(row, "summary") ?? "Untitled event",
              description: value<string>(row, "description"),
              start,
              end,
              timezone: value<string>(row, "start_tz"),
              endTimezone: value<string>(row, "end_tz"),
              recurrenceSemantics:
                value<"zoned" | "floating" | "all-day">(
                  row,
                  "recurrence_semantics"
                ) ?? "zoned",
              rrule: value<string>(row, "rrule"),
              status: value<string>(row, "status") ?? "confirmed",
            },
            rangeStart,
            rangeEnd,
            200,
            exceptions.rows
              .filter((exception) => value(exception, "target_id") === id)
              .map((exception) => {
                const raw = value<string>(exception, "override_json");
                let override: {
                  scope?: "occurrence" | "future";
                  start?: string;
                } = {};
                if (raw) {
                  try {
                    const parsed = JSON.parse(raw) as unknown;
                    if (parsed && typeof parsed === "object")
                      override = parsed as typeof override;
                  } catch {
                    // A malformed replicated override is ignored: one bad row
                    // must not blank the entire native Agenda.
                  }
                }
                return {
                  originalStart:
                    value<string>(exception, "original_start") ?? "",
                  action:
                    value<"skip" | "override">(exception, "action") ?? "skip",
                  scope:
                    value<"occurrence" | "future">(exception, "scope") ??
                    override.scope ??
                    "occurrence",
                  ...override,
                };
              })
          ).map((event): NativeAgendaEvent => ({ ...event, raw: row }));
        })
        .sort((a, b) => a.start.localeCompare(b.start)),
    [events.rows, eventExtensions.rows, exceptions.rows, rangeEnd, rangeStart]
  );

  // The starred set is derived once per read rather than per day row: it is a
  // fact about the vault, not about a day.
  const starred = useMemo(
    () => starredParties(schemes.rows, concepts.rows, tags.rows),
    [concepts.rows, schemes.rows, tags.rows]
  );

  return {
    events: rows,
    canonicalEvents: events.rows,
    dueTasks: tasks.rows,
    starred,
    attendees: attendees.rows,
    eventExtensions: eventExtensions.rows,
    parties: parties.rows,
    calendars: calendars.rows,
    ownerPartyId: value<string>(vault.rows[0] ?? {}, "owner_party_id"),
    ...queryState,
  };
}
