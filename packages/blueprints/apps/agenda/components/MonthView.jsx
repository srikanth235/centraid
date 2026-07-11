// The month canvas: a 6×7 Monday-first CSS grid (one flat grid — the 7
// weekday-header spans plus 42 day cells are all direct children, so no
// per-week wrapper row is needed). Up to 3 event pills per day (all-day /
// multi-day render as solid bars), a "+N more" past that, and clicking empty
// day space starts a proposal prefilled there.
import { bucketByDay, fmtRange, fmtTime, startOfWeek } from '../format.js';
import { localDayKey } from '../kit.js';
import { CalDot } from './Shared.jsx';

const MAX_PILLS = 3;
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Pill({ seg, colorFor, onEventOpen }) {
  const ev = seg.ev;
  const color = colorFor(ev.calendar_id);
  return (
    <button
      type="button"
      className="ag-pill"
      data-status={ev.status}
      data-spans={String(seg.spansAll)}
      style={{ '--ev-color': color }}
      title={`${fmtRange(ev)} — ${ev.summary}`}
      onClick={(e) => {
        e.stopPropagation();
        onEventOpen(ev);
      }}
    >
      {!seg.spansAll ? <CalDot color={color} /> : null}
      <span className="ag-pill-text">
        {seg.startsHere && !seg.spansAll ? `${fmtTime(ev.dtstart)} ${ev.summary}` : ev.summary}
      </span>
    </button>
  );
}

function DayCell({ date, outside, isToday, segs, colorFor, onCreate, onEventOpen, onMoreOpen }) {
  const overflow = segs.length > MAX_PILLS;
  const label = `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}, ${
    segs.length === 0 ? 'no events' : `${segs.length} event${segs.length === 1 ? '' : 's'}`
  }. Press Enter to propose an event.`;
  return (
    <div
      className="ag-day-cell"
      role="gridcell"
      tabIndex={0}
      data-outside={String(outside)}
      data-today={String(isToday)}
      aria-label={label}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest('.ag-pill, .ag-more')) return;
        onCreate(date);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCreate(date);
        }
      }}
    >
      <span className="ag-day-num">{date.getDate()}</span>
      <div className="ag-day-pills">
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
            className="ag-more"
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

export function MonthView({ cursor, events, colorFor, onDayCreate, onEventOpen, onMoreOpen }) {
  const month = cursor.getMonth();
  const byDay = bucketByDay(events);
  const gridStart = startOfWeek(new Date(cursor.getFullYear(), month, 1));
  const todayKey = localDayKey(new Date());
  const days = Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i),
  );

  return (
    <div className="ag-month" role="grid" aria-label="Month view">
      {DOW.map((d) => (
        <span className="ag-dow" role="columnheader" key={d}>
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
