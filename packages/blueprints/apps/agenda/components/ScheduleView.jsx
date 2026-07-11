// The schedule canvas: a grouped agenda list from the cursor forward — a day
// rail plus event cards with a calendar color bar, time, and a "cancel
// asked" chip on parked-cancel events. Search results (the vault FTS hits,
// snippet included) route here — same shape as the loaded window, so one
// component renders either source.
import { bucketByDay, segTimeText } from '../format.js';
import { localDayKey } from '../kit.js';
import { I } from '../icons.js';
import { Icon, Snippet } from './Shared.jsx';

function EventCard({ seg, colorFor, pending, onEventOpen }) {
  const ev = seg.ev;
  const color = colorFor(ev.calendar_id);
  return (
    <button
      type="button"
      className={pending ? 'ag-sched-card kit-pending' : 'ag-sched-card'}
      onClick={() => onEventOpen(ev)}
    >
      <span className="ag-sched-bar" style={{ background: color }} aria-hidden="true" />
      <span className="ag-sched-time">{segTimeText(seg)}</span>
      <span className="ag-sched-text">
        <span className={ev.status === 'tentative' ? 'ag-sched-title tentative' : 'ag-sched-title'}>
          {ev.summary}
        </span>
        {ev.snippet ? <Snippet snippet={ev.snippet} className="ag-sched-snippet" /> : null}
      </span>
      {pending ? <span className="kit-pending-chip">cancel asked</span> : null}
    </button>
  );
}

function DayGroup({ dayKey, segs, colorFor, pendingCancelIds, onEventOpen }) {
  const d = new Date(`${dayKey}T00:00:00`);
  const today = localDayKey(new Date()) === dayKey;
  return (
    <div className="ag-sched-day">
      <div className="ag-sched-rail">
        <div className="ag-sched-num" data-today={String(today)}>
          {d.getDate()}
        </div>
        <div className="ag-sched-dow">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
        <div className="ag-sched-my">{d.toLocaleDateString(undefined, { month: 'short' })}</div>
      </div>
      <div className="ag-sched-items">
        {segs.map((seg) => (
          <EventCard
            key={seg.ev.instance_key ?? seg.ev.event_id}
            seg={seg}
            colorFor={colorFor}
            pending={pendingCancelIds.has(seg.ev.event_id)}
            onEventOpen={onEventOpen}
          />
        ))}
      </div>
    </div>
  );
}

export function ScheduleView({ events, colorFor, pendingCancelIds, search, onEventOpen }) {
  const byDay = bucketByDay(events);
  const keys = [...byDay.keys()].sort();
  const isEmpty = keys.length === 0;
  const searching = Boolean(search.trim());

  return (
    <div className="ag-schedule">
      {keys.map((key) => (
        <DayGroup
          key={key}
          dayKey={key}
          segs={byDay.get(key)}
          colorFor={colorFor}
          pendingCancelIds={pendingCancelIds}
          onEventOpen={onEventOpen}
        />
      ))}
      {isEmpty ? (
        <div className="kit-empty">
          <div className="kit-empty-icon">
            <Icon svg={I.empty} />
          </div>
          <div className="kit-empty-title">{searching ? 'No matching events' : 'Nothing coming up'}</div>
          <div className="kit-empty-sub">
            {searching
              ? 'Try another title, or clear the search.'
              : 'Propose an event above, or jump ahead to a busier month.'}
          </div>
        </div>
      ) : null}
    </div>
  );
}
