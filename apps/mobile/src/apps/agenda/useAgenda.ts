import { useMemo } from "react";

import type { ReplicaRow } from "@centraid/client/replica/native";

import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import { expandEvent } from "../../kit/schedule/recurrence";

const value = <T>(row: ReplicaRow, key: string): T | undefined =>
  row[key] as T | undefined;

export function useAgenda(rangeStart: Date, rangeEnd: Date) {
  const events = useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity: "core.event" }), [])
  );
  const attendees = useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity: "schedule.attendee" }), [])
  );
  const eventExtensions = useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity: "schedule.event_ext" }), [])
  );
  const parties = useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const calendars = useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity: "schedule.calendar" }), [])
  );
  const exceptions = useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity: "schedule.recurrence_exception" }), [])
  );
  // The vault's owner party (issue #337) — the one attendee whose RSVP the
  // owner controls. core.vault is granted to the agenda shape, so this rides
  // the same offline replica as everything else.
  const vault = useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity: "core.vault" }), [])
  );
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
          // event (upcoming.js); match that instead of dropping the row.
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
                    // A malformed replicated override is ignored; one bad row
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
          );
        })
        .sort((a, b) => a.start.localeCompare(b.start)),
    [events.rows, eventExtensions.rows, exceptions.rows, rangeEnd, rangeStart]
  );
  return {
    events: rows,
    canonicalEvents: events.rows,
    attendees: attendees.rows,
    eventExtensions: eventExtensions.rows,
    parties: parties.rows,
    calendars: calendars.rows,
    ownerPartyId: value<string>(vault.rows[0] ?? {}, "owner_party_id"),
    ...queryState,
  };
}
