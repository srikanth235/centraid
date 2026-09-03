// Agenda read layer over this device's replica, within `agenda`'s read scopes.

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

/** One expanded occurrence, carrying the canonical row it came from. */
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
  // The owner party — whose RSVP the owner controls.
  const vault = useAgendaEntity("core.vault");
  // Day-context layers (#834): costless facts decorating a day, never rows;
  // member's OWN rows only.
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
            exceptions.rows
              .filter((exception) => value(exception, "target_id") === id)
              .map((exception) => {
                const raw = value<string>(exception, "override_json");
                let override: {
                  scope?: "occurrence" | "future";
                  start?: string;
                  end?: string;
                  summary?: string;
                  description?: string;
                  recurrence_semantics?: "zoned" | "floating" | "all-day";
                  calendar_id?: string;
                } = {};
                if (raw) {
                  try {
                    const parsed = JSON.parse(raw) as unknown;
                    if (parsed && typeof parsed === "object")
                      override = parsed as typeof override;
                  } catch {
                    // One bad replicated override must not blank the Agenda.
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
