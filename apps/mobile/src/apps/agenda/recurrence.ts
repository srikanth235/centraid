import {
  applyRecurrenceExceptions,
  expandRecurrence,
  parseWallIso,
  shiftTemporal,
  wallEpoch,
} from "@centraid/time-engine";
import type {
  RecurrenceException,
  RecurrenceSemantics,
} from "@centraid/time-engine";

export interface AgendaEventModel {
  id: string;
  calendarId?: string;
  instanceKey: string;
  originalStart: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  timezone?: string;
  endTimezone?: string;
  recurrenceSemantics?: RecurrenceSemantics;
  rrule?: string;
  status: string;
  isRecurrenceInstance: boolean;
  overlap?: boolean;
}

function eventDuration(
  event: Omit<
    AgendaEventModel,
    "instanceKey" | "originalStart" | "isRecurrenceInstance"
  >,
  semantics: RecurrenceSemantics
): number {
  if (semantics === "zoned")
    return Date.parse(event.end) - Date.parse(event.start);
  const start = parseWallIso(event.start);
  const end = parseWallIso(event.end);
  return start && end ? wallEpoch(end) - wallEpoch(start) : 0;
}

function overlapsWindow(
  start: string,
  end: string,
  from: Date,
  to: Date
): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return startMs < to.getTime() && endMs > from.getTime();
}

/** Materialize the same timezone-aware recurrence contract as web handlers. */
export function expandEvent(
  event: Omit<
    AgendaEventModel,
    "instanceKey" | "originalStart" | "isRecurrenceInstance"
  >,
  from: Date,
  to: Date,
  max = 200,
  exceptions: readonly RecurrenceException[] = []
): AgendaEventModel[] {
  if (!event.rrule) {
    return overlapsWindow(event.start, event.end, from, to)
      ? [
          {
            ...event,
            instanceKey: event.id,
            originalStart: event.start,
            isRecurrenceInstance: false,
          },
        ]
      : [];
  }
  const semantics = event.recurrenceSemantics ?? "zoned";
  const durationMs = eventDuration(event, semantics);
  const expanded = expandRecurrence({
    rrule: event.rrule,
    start: event.start,
    rangeFrom: from.toISOString(),
    rangeTo: to.toISOString(),
    timeZone: event.timezone ?? "Etc/UTC",
    semantics,
    maxInstances: max,
  });
  // Unsupported FREQ (e.g. HOURLY) used to vanish entirely; fall back to the
  // single anchor occurrence so free-text RRULE mistakes stay visible.
  const instances = applyRecurrenceExceptions(
    expanded.length > 0
      ? expanded
      : [
          {
            originalStart: event.start,
            start: event.start,
            wallStart: event.start,
            overlap: false,
          },
        ],
    exceptions
  );
  return instances
    .map((instance) => {
      const end =
        semantics === "zoned"
          ? new Date(Date.parse(instance.start) + durationMs).toISOString()
          : shiftTemporal(instance.start, durationMs);
      return {
        ...event,
        start: instance.start,
        end,
        originalStart: instance.originalStart,
        instanceKey: `${event.id}:${instance.originalStart}`,
        isRecurrenceInstance: instance.originalStart !== event.start,
        overlap: instance.overlap,
      };
    })
    .filter((instance) =>
      overlapsWindow(instance.start, instance.end, from, to)
    );
}
