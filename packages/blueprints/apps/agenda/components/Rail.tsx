// The rail's two content blocks: the month at a glance, and the calendars.
//
// The rail is not navigation — the shell's stem is. It is the app's own
// column of context: where in the month the member is, which calendars are
// showing, and (in the seam beside these) what decorates a day without
// occupying it.
import type { ReactNode } from "react";

import { displayText } from "../_shared/untrusted.ts";
import { localDayKey, startOfWeek } from "../format.ts";
import type { AgEvent, Calendar } from "../types.ts";
import { NEXT, PREVIOUS } from "../view-copy.ts";
import { CalendarDot, Num } from "./Shared.tsx";

import styles from "./Rail.module.css";

const WEEKDAY_KEYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** The Monday-first weekday initials, in the member's own locale. */
function weekdayHeads(): string[] {
  const monday = startOfWeek(new Date());
  return WEEKDAY_KEYS.map((offset) =>
    new Date(
      monday.getFullYear(),
      monday.getMonth(),
      monday.getDate() + offset
    ).toLocaleDateString(undefined, { weekday: "narrow" })
  );
}

export interface MiniMonthProps {
  anchor: Date;
  /** The events the mini month marks a day with — a dot, never a count: this
   *  product does not count at the member. */
  events: readonly AgEvent[];
  onPickDay: (day: Date) => void;
  onStep: (direction: -1 | 1) => void;
}

export function MiniMonth(props: MiniMonthProps): ReactNode {
  const first = new Date(props.anchor.getFullYear(), props.anchor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const busy = new Set(
    props.events.map((ev) => localDayKey(new Date(ev.dtstart)))
  );
  const todayKey = localDayKey(new Date());
  const anchorKey = localDayKey(props.anchor);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + index
    );
    return { date, key: localDayKey(date) };
  });

  return (
    <div className={styles.mini}>
      <div className={styles.miniHead}>
        <span className={styles.miniTitle}>
          {props.anchor.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </span>
        <button
          type="button"
          className="kit-icon-btn"
          aria-label={PREVIOUS}
          onClick={() => props.onStep(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="kit-icon-btn"
          aria-label={NEXT}
          onClick={() => props.onStep(1)}
        >
          ›
        </button>
      </div>
      <div className={styles.miniHeads} aria-hidden="true">
        {weekdayHeads().map((head, index) => (
          <span key={`head-${index}`}>{head}</span>
        ))}
      </div>
      <div className={styles.miniGrid}>
        {days.map(({ date, key }) => (
          <button
            key={key}
            type="button"
            className={styles.miniDay}
            data-outside={String(date.getMonth() !== props.anchor.getMonth())}
            data-today={String(key === todayKey)}
            aria-current={key === anchorKey ? "date" : undefined}
            aria-label={date.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
            onClick={() => props.onPickDay(date)}
          >
            <Num>{date.getDate()}</Num>
            {busy.has(key) ? (
              <span className={styles.miniBusy} aria-hidden="true" />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface CalendarListProps {
  calendars: readonly Calendar[];
  hidden: ReadonlySet<string>;
  hueFor: (calendarId: string | null | undefined) => string | null;
  onToggle: (calendarId: string) => void;
}

/**
 * The calendars, each with its hue dot. The dot is a CONTENT marker: the
 * checkbox beside it is a plain control in the system's own ink, because a
 * control that took the calendar's colour would be the defect the rulebook
 * names.
 */
export function CalendarList(props: CalendarListProps): ReactNode {
  return (
    <ul className={styles.calendars}>
      {props.calendars.map((calendar) => {
        const on = !props.hidden.has(calendar.calendar_id);
        return (
          <li key={calendar.calendar_id}>
            <label className={styles.calendarRow}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => props.onToggle(calendar.calendar_id)}
              />
              <CalendarDot hue={props.hueFor(calendar.calendar_id)} />
              <span className={styles.calendarName}>
                {displayText(calendar.name ?? calendar.calendar_id)}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
