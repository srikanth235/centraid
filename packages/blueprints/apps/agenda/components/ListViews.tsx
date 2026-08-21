// The two list views: Schedule (what is next) and Waiting on (invitations and
// unanswered RSVPs).
//
// They share one row because they are the same fact seen from two angles — a
// list of events with their day rail. What differs is the question each one
// answers, and that difference lives in what the caller passes: Schedule gets
// the window in order, Waiting on gets only the rows still owed an answer, and
// each carries its own empty line.
//
// The day group carries the SHELF SEAM: a day's collapsed day-context shelf
// sits under its date and above its first event, so a due-task count never
// becomes a row competing with a meeting.
import type { ReactNode } from "react";

import { eventTitle, fmtTime, localDayKey } from "../format.ts";
import type { AgEvent, DaySegment } from "../types.ts";
import {
  ALL_DAY,
  CONTINUES,
  PENDING_CANCEL_CHIP,
  RSVP_AWAITING,
} from "../view-copy.ts";
import { rowKey } from "../views.ts";
import { CalendarDot, Num, PendingMark, Safe, Snippet } from "./Shared.tsx";

import styles from "./ListViews.module.css";

export interface ListRowState {
  /** The row's held write, if it has one, already read from the overlay. */
  pending?: { status: string; action: string } | undefined;
}

export interface ListViewProps {
  /** Day key → the day's segments, in order. */
  groups: readonly { dayKey: string; segments: readonly DaySegment[] }[];
  hueFor: (calendarId: string | null | undefined) => string | null;
  pendingFor: (ev: AgEvent) => { status: string; action: string } | undefined;
  onOpen: (ev: AgEvent) => void;
  /** SEAM — the day-context shelf for this day, collapsed. */
  dayShelf?: (dayKey: string) => ReactNode;
  /** Waiting on marks each row with the answer still owed. */
  showAwaiting?: boolean;
}

/** Is this held write a cancellation the vault is holding? That row keeps its
 *  place on the agenda and says what is held, rather than vanishing. */
function isHeldCancel(
  pending: { status: string; action: string } | undefined
): boolean {
  return (
    pending?.action === "cancel-event" &&
    (pending.status === "queued" ||
      pending.status === "sending" ||
      pending.status === "parked")
  );
}

function Row({
  segment,
  hue,
  pending,
  onOpen,
  showAwaiting,
}: {
  segment: DaySegment;
  hue: string | null;
  pending: { status: string; action: string } | undefined;
  onOpen: (ev: AgEvent) => void;
  showAwaiting: boolean;
}): ReactNode {
  const ev = segment.ev;
  return (
    <button
      type="button"
      className={pending ? `${styles.row} kit-pending` : styles.row}
      // The row's stable identity, on the element. Boot and end-to-end
      // journeys address a row by what it IS rather than by a class name,
      // which is presentation and free to change.
      data-event-id={rowKey(ev)}
      onClick={() => onOpen(ev)}
    >
      <CalendarDot hue={hue} />
      <span className={styles.rowTime}>
        <Num>{segment.spansAll ? ALL_DAY : fmtTime(ev.dtstart)}</Num>
      </span>
      <span className={styles.rowText}>
        <span
          className={styles.rowTitle}
          data-tentative={String(ev.status === "tentative")}
        >
          <Safe value={eventTitle(ev)} />
        </span>
        {ev.snippet ? <Snippet snippet={ev.snippet} /> : null}
        {/* The ONE recurrence sentence, from the shared summariser. A raw
            rule never reaches this surface — the row does not hold one. */}
        {ev.recurrence_summary ? (
          <span className={styles.rowMeta}>
            <Safe value={ev.recurrence_summary} />
          </span>
        ) : null}
        {segment.clamped ? (
          <span className={styles.rowMeta}>{CONTINUES}</span>
        ) : null}
      </span>
      {showAwaiting ? (
        <span className={styles.rowAwaiting}>{RSVP_AWAITING}</span>
      ) : null}
      {pending ? (
        <span className="kit-pending-chip">
          {isHeldCancel(pending) ? PENDING_CANCEL_CHIP : pending.status}
        </span>
      ) : null}
      {pending ? <PendingMark /> : null}
    </button>
  );
}

export function ListView(props: ListViewProps): ReactNode {
  const todayKey = localDayKey(new Date());
  return (
    <div className={styles.list}>
      {props.groups.map(({ dayKey, segments }) => {
        const date = new Date(`${dayKey}T00:00:00`);
        return (
          <section key={dayKey} className={styles.day}>
            <div
              className={styles.rail}
              data-today={String(dayKey === todayKey)}
            >
              <span className={styles.railNum}>
                <Num>{date.getDate()}</Num>
              </span>
              <span className={styles.railDow}>
                {date.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span className={styles.railMonth}>
                {date.toLocaleDateString(undefined, { month: "short" })}
              </span>
            </div>
            <div className={styles.items}>
              {/* SEAM: the collapsed day shelf, above the day's first row. */}
              {props.dayShelf ? props.dayShelf(dayKey) : null}
              {segments.map((segment) => (
                <Row
                  key={rowKey(segment.ev)}
                  segment={segment}
                  hue={props.hueFor(segment.ev.calendar_id)}
                  pending={props.pendingFor(segment.ev)}
                  onOpen={props.onOpen}
                  showAwaiting={props.showAwaiting === true}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
