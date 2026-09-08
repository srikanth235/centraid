// Agenda read layer over this device's replica, within `agenda`'s read scopes.

import { useMemo } from "react";

import type { ReplicaRow } from "@centraid/client/replica/native";
import { occurrenceExceptionsOf } from "@centraid/core/time";

import { combineReplicaQueryStates } from "../../kit/hooks/useReplicaQuery";
import { useSeatWindow } from "../../kit/hooks/useSeatPages";
import { expandEvent } from "../../kit/schedule/recurrence";
import type {
  AgendaEventModel,
  NativeOverride,
} from "../../kit/schedule/recurrence";
import { MOBILE_ENTITY_READ_WINDOW } from "../../lib/replica/offline-budgets";
import { AGENDA_READS } from "./agenda-queries";
import { starredParties } from "./day-context";

const value = <T>(row: ReplicaRow, key: string): T | undefined =>
  row[key] as T | undefined;

/** One expanded occurrence, carrying the canonical row it came from. */
export type NativeAgendaEvent = AgendaEventModel & { raw: ReplicaRow };

/** One of Agenda's eleven sets, as one page of the year-3 window. */
function useAgendaEntity(name: keyof typeof AGENDA_READS) {
  const read = AGENDA_READS[name];
  return useSeatWindow("agenda", read.query, {
    entity: read.entity,
    rowIdColumn: read.rowIdColumn,
    limit: MOBILE_ENTITY_READ_WINDOW,
  });
}

export function useAgenda(rangeStart: Date, rangeEnd: Date) {
  const events = useAgendaEntity("events");
  const attendees = useAgendaEntity("attendees");
  const eventExtensions = useAgendaEntity("eventExtensions");
  const parties = useAgendaEntity("parties");
  const calendars = useAgendaEntity("calendars");
  const exceptions = useAgendaEntity("exceptions");
  const vault = useAgendaEntity("vault");
  // Day-context layers (#834): costless facts decorating a day, never rows;
  // member's OWN rows only.
  const tasks = useAgendaEntity("tasks");
  const tags = useAgendaEntity("tags");
  const concepts = useAgendaEntity("concepts");
  const schemes = useAgendaEntity("schemes");

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
          // A NULL dtend is zero-duration in the vault; match that, never drop.
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
            // THROUGH THE ONE ADAPTER (#996, ruling R21; drift ONT-25). This
            // read `original_start`, which is not the column — so every skip
            // matched nothing and a skipped occurrence stayed on the phone.
            occurrenceExceptionsOf<NativeOverride>(
              exceptions.rows as unknown as Record<string, unknown>[],
              { seriesType: "core.event", seriesId: id }
            )
          ).map((event): NativeAgendaEvent => ({ ...event, raw: row }));
        })
        .sort((a, b) => a.start.localeCompare(b.start)),
    [events.rows, eventExtensions.rows, exceptions.rows, rangeEnd, rangeStart]
  );

  // Derived once per read, not per day row.
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
    ownerPartyId: value<string>(vault.rows[0] ?? {}, "self_party_id"),
    ...queryState,
  };
}
