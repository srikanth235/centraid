// The week canvas: a scrollable Monday-first hour grid with an all-day lane,
// events positioned by time with overlap columns, a now-line on today, and
// click-a-slot to propose prefilled. Scrolls to ~7am whenever the displayed
// week changes (not on every unrelated re-render — an attach elsewhere must
// not jerk a manually-scrolled view back).
import { useEffect, useRef } from '../react-core.min.js';
import { bucketByDay, fmtRange, layoutDay, segTimeText, startOfWeek } from '../format.ts';
import { localDayKey } from '../kit.js';
import type { CSSProperties } from '../react-core.min.js';
import type { AgEvent, DaySegment } from '../types.ts';
import styles from './WeekView.module.css';

type ColorFor = (calendarId: string | null | undefined) => string | null;

const HOUR_PX = 48;

function WeekDayHead({ date, isToday }: { date: Date; isToday: boolean }) {
  return (
    <div className={styles.weekDayHead} data-today={String(isToday)}>
      <span className={styles.weekDow}>
        {date.toLocaleDateString(undefined, { weekday: 'short' })}
      </span>
      <span className={styles.weekNum}>{date.getDate()}</span>
    </div>
  );
}

function AllDayCell({
  date,
  byDay,
  colorFor,
  onEventOpen,
}: {
  date: Date;
  byDay: Map<string, DaySegment[]>;
  colorFor: ColorFor;
  onEventOpen: (ev: AgEvent) => void;
}) {
  const segs = (byDay.get(localDayKey(date)) ?? []).filter((s) => s.spansAll);
  return (
    <div className={styles.weekAlldayCell}>
      {segs.map((seg) => (
        <button
          key={seg.ev.instance_key ?? seg.ev.event_id}
          type="button"
          className={styles.alldayChip}
          style={{ '--ev-color': colorFor(seg.ev.calendar_id) ?? undefined } as CSSProperties}
          title={fmtRange(seg.ev)}
          onClick={() => onEventOpen(seg.ev)}
        >
          {seg.ev.summary}
        </button>
      ))}
    </div>
  );
}

function WeekAxis() {
  const hours = Array.from({ length: 23 }, (_, i) => i + 1);
  return (
    <div className={styles.weekAxis} style={{ height: 24 * HOUR_PX }}>
      {hours.map((h) => (
        <span key={h} className={styles.weekHour} style={{ top: h * HOUR_PX }}>
          {new Date(2024, 0, 1, h)
            .toLocaleTimeString(undefined, { hour: 'numeric' })
            .replace(' ', '')}
        </span>
      ))}
    </div>
  );
}

function WeekCol({
  date,
  byDay,
  isToday,
  colorFor,
  onSlotCreate,
  onEventOpen,
}: {
  date: Date;
  byDay: Map<string, DaySegment[]>;
  isToday: boolean;
  colorFor: ColorFor;
  onSlotCreate: (date: Date, at: Date) => void;
  onEventOpen: (ev: AgEvent) => void;
}) {
  const key = localDayKey(date);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const segs = (byDay.get(key) ?? []).filter((s) => !s.spansAll);
  const laidOut = layoutDay(segs);
  const now = new Date();
  const nowTop = (now.getHours() + now.getMinutes() / 60) * HOUR_PX;

  return (
    <div
      className={styles.weekCol}
      data-today={String(isToday)}
      style={{ height: 24 * HOUR_PX }}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest(`.${styles.weekEv}`)) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const hour = Math.max(
          0,
          Math.min(23.5, Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) / 2),
        );
        const at = new Date(
          date.getFullYear(),
          date.getMonth(),
          date.getDate(),
          Math.floor(hour),
          (hour % 1) * 60,
        );
        onSlotCreate(date, at);
      }}
    >
      {isToday ? (
        <span className={styles.nowLine} style={{ top: nowTop }} aria-hidden="true" />
      ) : null}
      {laidOut.map((seg) => {
        const top = ((seg.segStart - dayStart) / 3600000) * HOUR_PX;
        const height = Math.max(((seg.segEnd - seg.segStart) / 3600000) * HOUR_PX, 22);
        const color = colorFor(seg.ev.calendar_id);
        return (
          <button
            key={seg.ev.instance_key ?? seg.ev.event_id}
            type="button"
            className={styles.weekEv}
            data-status={seg.ev.status}
            style={
              {
                '--ev-color': color ?? undefined,
                top: `${top}px`,
                height: `${height}px`,
                left: `${(seg.col / seg.width) * 100}%`,
                width: `calc(${100 / seg.width}% - 2px)`,
              } as CSSProperties
            }
            title={`${fmtRange(seg.ev)} — ${seg.ev.summary}`}
            onClick={(e) => {
              e.stopPropagation();
              onEventOpen(seg.ev);
            }}
          >
            <span className={styles.weekEvTitle}>{seg.ev.summary}</span>
            <span className={styles.weekEvTime}>{segTimeText(seg)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function WeekView({
  cursor,
  events,
  colorFor,
  onSlotCreate,
  onEventOpen,
}: {
  cursor: Date;
  events: AgEvent[];
  colorFor: ColorFor;
  onSlotCreate: (date: Date, at: Date) => void;
  onEventOpen: (ev: AgEvent) => void;
}) {
  const start = startOfWeek(cursor);
  const days = Array.from(
    { length: 7 },
    (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
  const byDay = bucketByDay(events);
  const todayKey = localDayKey(new Date());
  const hasAllDay = days.some((d) => (byDay.get(localDayKey(d)) ?? []).some((s) => s.spansAll));
  const weekKey = localDayKey(start);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX;
  }, [weekKey]);

  return (
    <div className={styles.week}>
      <div className={styles.weekHead}>
        <span />
        {days.map((d) => (
          <WeekDayHead key={localDayKey(d)} date={d} isToday={localDayKey(d) === todayKey} />
        ))}
      </div>
      {hasAllDay ? (
        <div className={styles.weekAllday}>
          <span className={styles.weekAlldayLabel}>all-day</span>
          {days.map((d) => (
            <AllDayCell
              key={localDayKey(d)}
              date={d}
              byDay={byDay}
              colorFor={colorFor}
              onEventOpen={onEventOpen}
            />
          ))}
        </div>
      ) : null}
      <div className={styles.weekScroll} ref={scrollRef}>
        <div className={styles.weekGrid} style={{ height: 24 * HOUR_PX }}>
          <WeekAxis />
          {days.map((d) => (
            <WeekCol
              key={localDayKey(d)}
              date={d}
              byDay={byDay}
              isToday={localDayKey(d) === todayKey}
              colorFor={colorFor}
              onSlotCreate={onSlotCreate}
              onEventOpen={onEventOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
