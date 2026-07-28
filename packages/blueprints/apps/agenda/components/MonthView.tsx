import type { CSSProperties } from "react";

// The month canvas: a 6×7 Monday-first CSS grid (one flat grid — the 7
// weekday-header spans plus 42 day cells are all direct children, so no
// per-week wrapper row is needed). Up to 3 event pills per day (all-day /
// multi-day render as solid bars), a "+N more" past that, and clicking empty
// day space starts a proposal prefilled there.
import { bucketByDay, fmtRange, fmtTime, startOfWeek } from "../format.ts";
import { localDayKey } from "../kit.ts";
import type { AgEvent, DaySegment } from "../types.ts";
import { CalDot } from "./Shared.tsx";

import styles from "./MonthView.module.css";

type ColorFor = (calendarId: string | null | undefined) => string | null;

const MAX_PILLS = 3;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Pill({
  seg,
  colorFor,
  onEventOpen,
}: {
  seg: DaySegment;
  colorFor: ColorFor;
  onEventOpen: (ev: AgEvent) => void;
}) {
  const ev = seg.ev;
  const color = colorFor(ev.calendar_id);
  return (
    <button
      type="button"
      className={styles.pill}
      data-status={ev.status}
      data-spans={String(seg.spansAll)}
      style={{ "--ev-color": color ?? undefined } as CSSProperties}
      title={`${fmtRange(ev)} — ${ev.summary}`}
      onClick={(e) => {
        e.stopPropagation();
        onEventOpen(ev);
      }}
    >
      {seg.spansAll ? null : <CalDot color={color} />}
      <span className={styles.pillText}>
        {seg.startsHere && !seg.spansAll
          ? `${fmtTime(ev.dtstart)} ${ev.summary}`
          : ev.summary}
      </span>
    </button>
  );
}

function DayCell({
  date,
  outside,
  isToday,
  segs,
  colorFor,
  onCreate,
  onEventOpen,
  onMoreOpen,
}: {
  date: Date;
  outside: boolean;
  isToday: boolean;
  segs: DaySegment[];
  colorFor: ColorFor;
  onCreate: (date: Date) => void;
  onEventOpen: (ev: AgEvent) => void;
  onMoreOpen: (dayKey: string, anchorEl: HTMLElement) => void;
}) {
  const overflow = segs.length > MAX_PILLS;
  const label = `${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}, ${
    segs.length === 0
      ? "no events"
      : `${segs.length} event${segs.length === 1 ? "" : "s"}`
  }. Press Enter to propose an event.`;
  return (
    <div
      className={styles.dayCell}
      data-outside={String(outside)}
      data-today={String(isToday)}
    >
      {/* Empty day space proposes an event. That is a real button laid over the
          cell (issue #573) rather than a click+keydown pair on the cell div:
          the pills and the "+N more" button sit above it, so the old
          `closest('.pill, .more')` guard is no longer needed. */}
      <button
        type="button"
        className={`kit-stretch-btn ${styles.dayOpen}`}
        aria-label={label}
        onClick={() => onCreate(date)}
      />
      <span className={styles.dayNum}>{date.getDate()}</span>
      <div className={styles.dayPills}>
        {segs.slice(0, MAX_PILLS).map((seg) => (
          <Pill
            key={seg.ev.instance_key ?? seg.ev.event_id}
            seg={seg}
            colorFor={colorFor}
            onEventOpen={onEventOpen}
          />
        ))}
        {overflow ? (
          <button
            type="button"
            className={styles.more}
            onClick={(e) => {
              e.stopPropagation();
              onMoreOpen(localDayKey(date), e.currentTarget);
            }}
          >
            +{segs.length - MAX_PILLS} more
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function MonthView({
  cursor,
  events,
  colorFor,
  onDayCreate,
  onEventOpen,
  onMoreOpen,
}: {
  cursor: Date;
  events: AgEvent[];
  colorFor: ColorFor;
  onDayCreate: (date: Date) => void;
  onEventOpen: (ev: AgEvent) => void;
  onMoreOpen: (dayKey: string, anchorEl: HTMLElement) => void;
}) {
  const month = cursor.getMonth();
  const byDay = bucketByDay(events);
  const gridStart = startOfWeek(new Date(cursor.getFullYear(), month, 1));
  const todayKey = localDayKey(new Date());
  const days = Array.from(
    { length: 42 },
    (_, i) =>
      new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + i
      )
  );

  // No `role="grid"`: this flat CSS grid has no `role="row"` rows, so the grid
  // semantics never reached a screen reader (#573) — the day-of-week spans are
  // plain text and each day cell names itself on the button that acts on it.
  return (
    <div className={styles.month}>
      {DOW.map((d) => (
        <span className={styles.dow} key={d}>
          {d}
        </span>
      ))}
      {days.map((date) => {
        const key = localDayKey(date);
        return (
          <DayCell
            key={key}
            date={date}
            outside={date.getMonth() !== month}
            isToday={key === todayKey}
            segs={byDay.get(key) ?? []}
            colorFor={colorFor}
            onCreate={onDayCreate}
            onEventOpen={onEventOpen}
            onMoreOpen={onMoreOpen}
          />
        );
      })}
    </div>
  );
}
