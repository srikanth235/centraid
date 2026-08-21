// The three grids: Month (6×7 cells), Week (7 day columns) and Day (one).
//
// THE GRID IS FOR THINGS WITH A TIME COST. Every row drawn here came from
// `core.event`; nothing costless is turned into one. The costless facts about
// a day — a birthday, a task coming due, a holiday — arrive through the two
// SEAMS this file exposes and never as a row:
//
//   * `dayRibbon(dayKey)` — drawn INSIDE the day header, above the grid body.
//   * `dayShelf(dayKey)`  — drawn under the header, above the first hour, as a
//                           collapsed shelf rather than chips competing with
//                           meetings.
//
// Both default to nothing, so the grid is complete without them and gains the
// layers without a change to its geometry.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { eventTitle, fmtHour, fmtTime, localDayKey } from "../format.ts";
import type { AgEvent, DaySegment } from "../types.ts";
import { ALL_DAY, CONTINUES, NOW } from "../view-copy.ts";
import {
  layoutDay,
  nowLineMinutes,
  rowKey,
  segmentBox,
  splitDay,
} from "../views.ts";
import { CalendarDot, Num, PendingMark, Safe } from "./Shared.tsx";

import styles from "./Grid.module.css";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES_IN_DAY = 24 * 60;

/** What every grid needs from the orchestrator, plus the two wave-2 seams. */
export interface GridCommonProps {
  buckets: Map<string, DaySegment[]>;
  hueFor: (calendarId: string | null | undefined) => string | null;
  /** True while the row's write is still on this device. */
  isPending: (ev: AgEvent) => boolean;
  onOpen: (ev: AgEvent) => void;
  /** Quick add on a slot: the member gets a title field, then Edit. */
  onQuickAdd: (start: Date) => void;
  /** SEAM — the day-context ribbon, drawn in the day header. */
  dayRibbon?: (dayKey: string) => ReactNode;
  /** SEAM — the day-context shelf, drawn under the day header. */
  dayShelf?: (dayKey: string) => ReactNode;
}

function dayFromKey(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

/** One event, as it appears inside a grid. */
function GridEvent({
  segment,
  hue,
  pending,
  onOpen,
}: {
  segment: DaySegment;
  hue: string | null;
  pending: boolean;
  onOpen: (ev: AgEvent) => void;
}): ReactNode {
  const ev = segment.ev;
  return (
    <button
      type="button"
      className={pending ? `${styles.event} kit-pending` : styles.event}
      data-event-id={rowKey(ev)}
      data-clamped={String(segment.clamped)}
      onClick={() => onOpen(ev)}
    >
      <CalendarDot hue={hue} />
      <span className={styles.eventTime}>
        <Num>{segment.spansAll ? ALL_DAY : fmtTime(ev.dtstart)}</Num>
      </span>
      <span className={styles.eventTitle}>
        <Safe value={eventTitle(ev)} />
      </span>
      {/* A run that leaves this day says so in words. V1 draws it on the day
          it starts rather than as a bar across columns. */}
      {segment.clamped ? (
        <span className={styles.eventNote}>{CONTINUES}</span>
      ) : null}
      {pending ? <PendingMark /> : null}
    </button>
  );
}

/** The day header shared by Week and Day: the date, then the ribbon seam. */
function DayHead({
  dayKey,
  dayRibbon,
}: {
  dayKey: string;
  dayRibbon?: (dayKey: string) => ReactNode;
}): ReactNode {
  const date = dayFromKey(dayKey);
  const today = dayKey === localDayKey(new Date());
  return (
    <div className={styles.dayHead} data-today={String(today)}>
      <span className={styles.dayDow}>
        {date.toLocaleDateString(undefined, { weekday: "short" })}
      </span>
      <span className={styles.dayNum}>
        <Num>{date.getDate()}</Num>
      </span>
      {/* SEAM: the day-context ribbon. Nothing renders until a layer mounts. */}
      {dayRibbon ? dayRibbon(dayKey) : null}
    </div>
  );
}

export interface MonthGridProps extends GridCommonProps {
  days: readonly string[];
  anchorMonth: number;
  onPickDay: (day: Date) => void;
}

export function MonthGrid(props: MonthGridProps): ReactNode {
  return (
    <div className={styles.month} aria-label="Month">
      {props.days.map((dayKey) => {
        const date = dayFromKey(dayKey);
        const segments = props.buckets.get(dayKey) ?? [];
        return (
          <div
            key={dayKey}
            className={styles.cell}
            data-outside={String(date.getMonth() !== props.anchorMonth)}
            data-today={String(dayKey === localDayKey(new Date()))}
          >
            <div className={styles.cellHead}>
              <button
                type="button"
                className={styles.cellDay}
                aria-label={date.toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
                onClick={() => props.onPickDay(date)}
              >
                <Num>{date.getDate()}</Num>
              </button>
              {props.dayRibbon ? props.dayRibbon(dayKey) : null}
            </div>
            {props.dayShelf ? props.dayShelf(dayKey) : null}
            <div className={styles.cellRows}>
              {segments.map((segment) => (
                <GridEvent
                  key={rowKey(segment.ev)}
                  segment={segment}
                  hue={props.hueFor(segment.ev.calendar_id)}
                  pending={props.isPending(segment.ev)}
                  onOpen={props.onOpen}
                />
              ))}
            </div>
            <button
              type="button"
              className={styles.cellAdd}
              aria-label={`New event on ${date.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`}
              onClick={() =>
                props.onQuickAdd(new Date(date.getTime() + 9 * 60 * 60 * 1000))
              }
            >
              +
            </button>
          </div>
        );
      })}
    </div>
  );
}

export interface TimeGridProps extends GridCommonProps {
  days: readonly string[];
}

/**
 * Week and Day are the SAME grid at two column counts — a single component,
 * because "one column" and "seven columns" is a measure question, not two
 * different screens.
 *
 * OPENING LANDS AT NOW. The scroll host is driven to `anchorMinutes` on mount
 * and whenever it changes, which is what makes the anchor recompute when the
 * view or the day changes rather than only on first paint.
 */
export function TimeGrid(
  props: TimeGridProps & { anchorMinutes: number }
): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { anchorMinutes } = props;
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const full = host.scrollHeight;
    host.scrollTop = (anchorMinutes / MINUTES_IN_DAY) * full;
  }, [anchorMinutes, props.days]);

  const allDayRows = props.days.map(
    (dayKey) => splitDay(props.buckets.get(dayKey) ?? []).allDay
  );
  const hasAllDay = allDayRows.some((row) => row.length > 0);

  return (
    <div className={styles.timeGrid} data-columns={props.days.length}>
      <div className={styles.timeHeads}>
        <div className={styles.gutterHead} aria-hidden="true" />
        {props.days.map((dayKey) => (
          <DayHead
            key={dayKey}
            dayKey={dayKey}
            {...(props.dayRibbon ? { dayRibbon: props.dayRibbon } : {})}
          />
        ))}
      </div>

      {/* The all-day rail. A whole-day fact has no position inside the grid,
          so it sits above it rather than being stretched across 24 hours. */}
      {hasAllDay ? (
        <div className={styles.allDayRail}>
          <div className={styles.gutterHead}>
            <span className={styles.gutterLabel}>{ALL_DAY}</span>
          </div>
          {props.days.map((dayKey, index) => (
            <div key={dayKey} className={styles.allDayCell}>
              {(allDayRows[index] ?? []).map((segment) => (
                <GridEvent
                  key={rowKey(segment.ev)}
                  segment={segment}
                  hue={props.hueFor(segment.ev.calendar_id)}
                  pending={props.isPending(segment.ev)}
                  onOpen={props.onOpen}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* SEAM: the day shelf, between the header and the first hour. */}
      {props.dayShelf ? (
        <div className={styles.shelfRail}>
          <div className={styles.gutterHead} aria-hidden="true" />
          {props.days.map((dayKey) => (
            <div key={dayKey} className={styles.shelfCell}>
              {props.dayShelf?.(dayKey)}
            </div>
          ))}
        </div>
      ) : null}

      <div className={styles.timeScroll} ref={scrollRef}>
        <div className={styles.timeBody}>
          <div className={styles.gutter} aria-hidden="true">
            {HOURS.map((hour) => (
              <div key={hour} className={styles.gutterHour}>
                <span className={styles.gutterText}>
                  <Num>{fmtHour(hour)}</Num>
                </span>
              </div>
            ))}
          </div>
          {props.days.map((dayKey) => (
            <DayColumn
              key={dayKey}
              dayKey={dayKey}
              segments={splitDay(props.buckets.get(dayKey) ?? []).timed}
              hueFor={props.hueFor}
              isPending={props.isPending}
              onOpen={props.onOpen}
              onQuickAdd={props.onQuickAdd}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  dayKey,
  segments,
  hueFor,
  isPending,
  onOpen,
  onQuickAdd,
}: {
  dayKey: string;
  segments: readonly DaySegment[];
  hueFor: (calendarId: string | null | undefined) => string | null;
  isPending: (ev: AgEvent) => boolean;
  onOpen: (ev: AgEvent) => void;
  onQuickAdd: (start: Date) => void;
}): ReactNode {
  const laid = layoutDay(segments);
  const nowMinutes = nowLineMinutes(dayKey);
  const dayStart = dayFromKey(dayKey);
  return (
    <div className={styles.column}>
      {HOURS.map((hour) => (
        <button
          key={hour}
          type="button"
          className={styles.slot}
          aria-label={`New event at ${fmtHour(hour)} on ${dayStart.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`}
          onClick={() =>
            onQuickAdd(new Date(dayStart.getTime() + hour * 60 * 60 * 1000))
          }
        />
      ))}
      {laid.map((segment) => {
        const box = segmentBox(segment);
        return (
          <div
            key={rowKey(segment.ev)}
            className={styles.placed}
            style={{
              top: `${box.top}%`,
              height: `${box.height}%`,
              insetInlineStart: `${(segment.col / Math.max(segment.width, 1)) * 100}%`,
              inlineSize: `${100 / Math.max(segment.width, 1)}%`,
            }}
          >
            <GridEvent
              segment={segment}
              hue={hueFor(segment.ev.calendar_id)}
              pending={isPending(segment.ev)}
              onOpen={onOpen}
            />
          </div>
        );
      })}
      {/* The now line, on exactly the one column that is today. Its time is a
          numeric, so it carries the tabular/isolate pair like every other. */}
      {nowMinutes === null ? null : (
        <div
          className={styles.nowLine}
          style={{ top: `${(nowMinutes / MINUTES_IN_DAY) * 100}%` }}
        >
          <span className={styles.nowText}>
            <Num>
              {fmtTime(new Date(dayStart.getTime() + nowMinutes * 60_000))}
            </Num>
          </span>
          <span className="kit-sr-only">{NOW}</span>
        </div>
      )}
    </div>
  );
}
