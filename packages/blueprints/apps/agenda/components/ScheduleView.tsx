// The schedule canvas: a grouped agenda list from the cursor forward — a day
// rail plus event cards with a calendar color bar, time, and a "cancel
// asked" chip on parked-cancel events. Search results (the vault FTS hits,
// snippet included) route here — same shape as the loaded window, so one
// component renders either source.
import { bucketByDay, segTimeText } from '../format.ts';
import { localDayKey } from '../kit.ts';
import { I } from '../icons.ts';
import { Icon, Snippet } from './Shared.tsx';
import type { AgEvent, DaySegment } from '../types.ts';
import styles from './ScheduleView.module.css';

type ColorFor = (calendarId: string | null | undefined) => string | null;

function EventCard({
  seg,
  colorFor,
  pending,
  onEventOpen,
}: {
  seg: DaySegment;
  colorFor: ColorFor;
  pending: boolean;
  onEventOpen: (ev: AgEvent) => void;
}) {
  const ev = seg.ev;
  const color = colorFor(ev.calendar_id);
  return (
    <button
      type="button"
      className={pending ? `${styles.schedCard} kit-pending` : styles.schedCard}
      onClick={() => onEventOpen(ev)}
    >
      <span
        className={styles.schedBar}
        style={{ background: color ?? undefined }}
        aria-hidden="true"
      />
      <span className={styles.schedTime}>{segTimeText(seg)}</span>
      <span className={styles.schedText}>
        {/* `ag-sched-title` stays a GLOBAL class (styled in app.css): the
            app-boot harness queries `.ag-sched-title` on rendered content, so
            it must not be module-hashed. `tentative` is the shared global
            state modifier. */}
        <span className={ev.status === 'tentative' ? 'ag-sched-title tentative' : 'ag-sched-title'}>
          {ev.summary}
        </span>
        {ev.snippet ? <Snippet snippet={ev.snippet} className={styles.schedSnippet} /> : null}
      </span>
      {pending ? <span className="kit-pending-chip">cancel asked</span> : null}
    </button>
  );
}

function DayGroup({
  dayKey,
  segs,
  colorFor,
  pendingCancelIds,
  onEventOpen,
}: {
  dayKey: string;
  segs: DaySegment[];
  colorFor: ColorFor;
  pendingCancelIds: Set<string>;
  onEventOpen: (ev: AgEvent) => void;
}) {
  const d = new Date(`${dayKey}T00:00:00`);
  const today = localDayKey(new Date()) === dayKey;
  return (
    <div className={styles.schedDay}>
      <div className={styles.schedRail}>
        <div className={styles.schedNum} data-today={String(today)}>
          {d.getDate()}
        </div>
        <div className={styles.schedDow}>
          {d.toLocaleDateString(undefined, { weekday: 'short' })}
        </div>
        <div className={styles.schedMy}>{d.toLocaleDateString(undefined, { month: 'short' })}</div>
      </div>
      <div className={styles.schedItems}>
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

export function ScheduleView({
  events,
  colorFor,
  pendingCancelIds,
  search,
  onEventOpen,
}: {
  events: AgEvent[];
  colorFor: ColorFor;
  pendingCancelIds: Set<string>;
  search: string;
  onEventOpen: (ev: AgEvent) => void;
}) {
  const byDay = bucketByDay(events);
  const keys = [...byDay.keys()].sort();
  const isEmpty = keys.length === 0;
  const searching = Boolean(search.trim());

  return (
    <div className={styles.schedule}>
      {keys.map((key) => (
        <DayGroup
          key={key}
          dayKey={key}
          segs={byDay.get(key) ?? []}
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
          <div className="kit-empty-title">
            {searching ? 'No matching events' : 'Nothing coming up'}
          </div>
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
