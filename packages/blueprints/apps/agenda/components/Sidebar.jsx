// The sidebar's two dynamic regions — the mini-month navigator and the "My
// calendars" visibility list — mounted at their own React roots. The brand
// row, "Create event" button and the trust footer line are static HTML in
// index.html (stable, no per-render data), wired once in chrome.js.
import { bucketByDay, colorForCalendar, startOfWeek } from '../format.js';
import { localDayKey } from '../kit.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

const MONDAY = new Date(2024, 0, 1); // a known Monday, for the weekday header labels

export function MiniMonth({ cursor, miniEvents, onPickDay, onPrev, onNext }) {
  const byDay = bucketByDay(miniEvents ?? []);
  const gridStart = startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const todayKey = localDayKey(new Date());
  const cursorKey = localDayKey(cursor);
  const days = Array.from({ length: 42 }, (_, i) =>
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i),
  );
  const dow = Array.from({ length: 7 }, (_, i) =>
    new Date(MONDAY.getFullYear(), MONDAY.getMonth(), MONDAY.getDate() + i).toLocaleDateString(undefined, {
      weekday: 'narrow',
    }),
  );

  return (
    <div className="ag-mini">
      <div className="ag-mini-head">
        <span className="ag-mini-label">
          {cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
        <div className="ag-mini-nav">
          <button type="button" className="kit-icon-btn" onClick={onPrev} aria-label="Previous month">
            <Icon svg={I.miniLeft} />
          </button>
          <button type="button" className="kit-icon-btn" onClick={onNext} aria-label="Next month">
            <Icon svg={I.miniRight} />
          </button>
        </div>
      </div>
      <div className="ag-mini-dow" aria-hidden="true">
        {dow.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="ag-mini-grid" role="grid" aria-label="Mini month">
        {days.map((d) => {
          const key = localDayKey(d);
          const outside = d.getMonth() !== cursor.getMonth();
          const isToday = key === todayKey;
          const isSelected = key === cursorKey && !isToday;
          const hasEvents = (byDay.get(key) ?? []).length > 0;
          const label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
          return (
            <button
              key={key}
              type="button"
              className="ag-mini-day"
              role="gridcell"
              data-today={String(isToday)}
              data-selected={String(isSelected)}
              data-outside={String(outside)}
              aria-label={label}
              onClick={() => onPickDay(d)}
            >
              {d.getDate()}
              {hasEvents ? <span className="ag-mini-dot" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarList({ calendars, hiddenCals, counts, onToggle }) {
  if (!calendars.length) return null;
  return (
    <div className="ag-cals" role="group" aria-label="My calendars">
      {calendars.map((c) => {
        const shown = !hiddenCals.has(c.calendar_id);
        const color = colorForCalendar(c, c.calendar_id);
        return (
          <button
            key={c.calendar_id}
            type="button"
            className="ag-cal-row"
            aria-pressed={String(shown)}
            onClick={() => onToggle(c.calendar_id)}
          >
            <span className="ag-cal-box" data-shown={String(shown)} style={shown ? { background: color } : undefined}>
              {shown ? <Icon svg={I.check} /> : null}
            </span>
            <span className="ag-cal-name" data-shown={String(shown)}>
              {c.name ?? 'Calendar'}
            </span>
            <span className="ag-cal-count">{counts.get(c.calendar_id) ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}
