import {
  applyRecurrenceExceptions,
  expandRecurrence,
  parseWallIso,
  shiftTemporal,
  wallEpoch,
} from "@centraid/core/time";
import type {
  RecurrenceException,
  RecurrenceSemantics,
} from "@centraid/core/time";

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

function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function civilDate(value: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function nativeEventBounds(
  start: Date,
  end: Date,
  allDay: boolean
): {
  dtstart: string;
  dtend: string;
  start_tz: string;
  recurrence_semantics: RecurrenceSemantics;
} {
  if (allDay) {
    return {
      dtstart: civilDate(start),
      dtend: civilDate(end),
      start_tz: viewerTimeZone(),
      recurrence_semantics: "all-day",
    };
  }
  return {
    dtstart: start.toISOString(),
    dtend: end.toISOString(),
    start_tz: viewerTimeZone(),
    recurrence_semantics: "zoned",
  };
}

function asInstant(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value}T00:00:00`);
}

function overlapsWindow(
  start: string,
  end: string,
  from: Date,
  to: Date
): boolean {
  const startMs = asInstant(start);
  const endMs = asInstant(end);
  return startMs < to.getTime() && endMs > from.getTime();
}

type NativeException = RecurrenceException & {
  summary?: string;
  description?: string;
  end?: string;
  recurrence_semantics?: RecurrenceSemantics;
  calendar_id?: string;
};

function extraOverride(
  exceptions: readonly NativeException[],
  originalStart: string
): NativeException | undefined {
  const occurrence = exceptions.find(
    (item) =>
      item.originalStart === originalStart &&
      item.action === "override" &&
      (item.scope ?? "occurrence") === "occurrence"
  );
  if (occurrence) return occurrence;
  return exceptions
    .filter(
      (item) =>
        item.action === "override" &&
        item.scope === "future" &&
        item.originalStart <= originalStart
    )
    .slice()
    .sort((left, right) =>
      right.originalStart.localeCompare(left.originalStart)
    )[0];
}

export function expandEvent(
  event: Omit<
    AgendaEventModel,
    "instanceKey" | "originalStart" | "isRecurrenceInstance"
  >,
  from: Date,
  to: Date,
  max = 200,
  exceptions: readonly NativeException[] = []
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
      const extra = extraOverride(exceptions, instance.originalStart);
      const end =
        extra?.end ??
        (semantics === "zoned"
          ? new Date(Date.parse(instance.start) + durationMs).toISOString()
          : shiftTemporal(instance.start, durationMs));
      return {
        ...event,
        start: instance.start,
        end,
        originalStart: instance.originalStart,
        instanceKey: `${event.id}:${instance.originalStart}`,
        isRecurrenceInstance: instance.originalStart !== event.start,
        overlap: instance.overlap,
        ...(extra?.summary === undefined ? {} : { summary: extra.summary }),
        ...(extra?.description === undefined
          ? {}
          : { description: extra.description }),
        ...(extra?.recurrence_semantics === undefined
          ? {}
          : { recurrenceSemantics: extra.recurrence_semantics }),
        ...(extra?.calendar_id === undefined
          ? {}
          : { calendarId: extra.calendar_id }),
      };
    })
    .filter((instance) =>
      overlapsWindow(instance.start, instance.end, from, to)
    );
}
