// The sidebar's two dynamic regions — the mini-month navigator and the "My
// calendars" visibility list — mounted at their own React roots. The brand
// row, "Create event" button and the trust footer line are static HTML in
// index.html (stable, no per-render data), wired once in chrome.ts.
import { bucketByDay, colorForCalendar, startOfWeek } from '../format.ts';
import { localDayKey } from '../kit.ts';
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import type { AgEvent, Calendar } from '../types.ts';
import styles from './Sidebar.module.css';

const MONDAY = new Date(2024, 0, 1); // a known Monday, for the weekday header labels

export function MiniMonth({
  cursor,
  miniEvents,
  onPickDay,
  onPrev,
  onNext,
}: {
  cursor: Date;
  miniEvents: AgEvent[];
  onPickDay: (date: Date) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const byDay = bucketByDay(miniEvents ?? []);
  const gridStart = startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const todayKey = localDayKey(new Date());
  const cursorKey = localDayKey(cursor);
  const days = Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i),
  );
  const dow = Array.from({ length: 7 }, (_, i) =>
    new Date(MONDAY.getFullYear(), MONDAY.getMonth(), MONDAY.getDate() + i).toLocaleDateString(
      undefined,
      {
        weekday: 'narrow',
      },
    ),
  );

  return (
    <div className={styles.mini}>
      <div className={styles.miniHead}>
        <span className={styles.miniLabel}>
          {cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
        <div className={styles.miniNav}>
          <button
            type="button"
            className="kit-icon-btn"
            onClick={onPrev}
            aria-label="Previous month"
          >
            <Icon svg={I.miniLeft} />
          </button>
          <button type="button" className="kit-icon-btn" onClick={onNext} aria-label="Next month">
            <Icon svg={I.miniRight} />
          </button>
        </div>
      </div>
      <div className={styles.miniDow} aria-hidden="true">
        {dow.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className={styles.miniGrid} role="grid" aria-label="Mini month">
        {days.map((d) => {
          const key = localDayKey(d);
          const outside = d.getMonth() !== cursor.getMonth();
          const isToday = key === todayKey;
          const isSelected = key === cursorKey && !isToday;
          const hasEvents = (byDay.get(key) ?? []).length > 0;
          const label = d.toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          });
          return (
            <button
              key={key}
              type="button"
              className={styles.miniDay}
              role="gridcell"
              data-today={String(isToday)}
              data-selected={String(isSelected)}
              data-outside={String(outside)}
              aria-label={label}
              onClick={() => onPickDay(d)}
            >
              {d.getDate()}
              {hasEvents ? <span className={styles.miniDot} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarList({
  calendars,
  hiddenCals,
  counts,
  onToggle,
}: {
  calendars: Calendar[];
  hiddenCals: Set<string>;
  counts: Map<string, number>;
  onToggle: (calendarId: string) => void;
}) {
  if (!calendars.length) return null;
  return (
    <div className={styles.cals} role="group" aria-label="My calendars">
      {calendars.map((c) => {
        const shown = !hiddenCals.has(c.calendar_id);
        const color = colorForCalendar(c, c.calendar_id);
        return (
          <button
            key={c.calendar_id}
            type="button"
            className={styles.calRow}
            aria-pressed={shown}
            onClick={() => onToggle(c.calendar_id)}
          >
            <span
              className={styles.calBox}
              data-shown={String(shown)}
              style={shown ? { background: color ?? undefined } : undefined}
            >
              {shown ? <Icon svg={I.check} /> : null}
            </span>
            <span className={styles.calName} data-shown={String(shown)}>
              {c.name ?? 'Calendar'}
            </span>
            <span className={styles.calCount}>{counts.get(c.calendar_id) ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}
