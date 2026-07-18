// The right slide-over event detail drawer. Mounted keyed by event_id at the
// call site (app.tsx) so switching events remounts this component fresh —
// local reschedule-draft state always starts from the newly opened event, no
// stale-buffer bugs. Guests render only when the event carries an `attendees`
// list — upcoming.ts/search.ts join schedule_attendee → core_party per event
// (issue #337); the "You" row (is_you) gets RSVP controls, other guests show
// their PARTSTAT.
import { useEffect, useRef, useState } from '../react-core.min.js';
import { armConfirm, outcomeMessage, renderAttachments } from '../kit.js';
import { fmtRange, initials, toIsoUtc, toLocalInput } from '../format.ts';
import { I } from '../icons.ts';
import { CalDot, Icon } from './Shared.tsx';
import type { ChangeEvent } from '../react-core.min.js';
import type { ActivityEntry, AgEvent, Attendee } from '../types.ts';
import styles from './EventDrawer.module.css';
import shared from './shared.module.css';

const REPEAT_LABEL: Record<string, string> = {
  DAILY: 'Repeats daily',
  WEEKLY: 'Repeats weekly',
  MONTHLY: 'Repeats monthly',
  YEARLY: 'Repeats yearly',
};

/** A short human label for a stored rrule's FREQ — "Repeats weekly" etc. */
function repeatLabel(rrule?: string | null): string | null {
  const match = /FREQ=([A-Z]+)/.exec(String(rrule ?? ''));
  const freq = match?.[1];
  return freq ? (REPEAT_LABEL[freq] ?? 'Repeats') : null;
}

const RSVP_OPTIONS: [string, string, string][] = [
  ['accepted', 'Going', I.check],
  ['tentative', 'Maybe', I.maybe],
  ['declined', 'Decline', I.decline],
];
const PARTSTAT_LABEL: Record<string, string> = {
  accepted: 'Going',
  declined: 'No',
  tentative: 'Maybe',
  'needs-action': 'Invited',
};

function GuestRow({ attendee, onPick }: { attendee: Attendee; onPick: (value: string) => void }) {
  if (attendee.is_you) {
    return (
      <div className={styles.guestRow}>
        <span className={styles.guestAvatar}>You</span>
        <span className={styles.guestName}>You</span>
        <div className={styles.guestOpts}>
          {RSVP_OPTIONS.map(([value, title, svg]) => (
            <button
              key={value}
              type="button"
              className={styles.guestOpt}
              data-active={String(attendee.partstat === value)}
              title={title}
              aria-label={title}
              onClick={() => onPick(value)}
            >
              <Icon svg={svg} />
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={styles.guestRow}>
      <span className={styles.guestAvatar}>{initials(attendee.name)}</span>
      <span className={styles.guestName}>{attendee.name}</span>
      <span className={styles.guestStat} data-stat={attendee.partstat}>
        {PARTSTAT_LABEL[attendee.partstat] ?? 'Invited'}
      </span>
    </div>
  );
}

function AttachStrip({
  event,
  onRemove,
}: {
  event: AgEvent;
  onRemove: (attachmentId: string) => Promise<VaultOutcome | undefined>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current)
      renderAttachments(
        ref.current,
        (event.attachments ?? []) as Parameters<typeof renderAttachments>[1],
        onRemove,
      );
  }, [event.attachments, onRemove]);
  if (!event.attachments?.length) return null;
  return <div className={`kit-attach-strip ${styles.drawerAttach}`} ref={ref} />;
}

export function EventDrawer({
  event,
  calendarName,
  color,
  pending,
  pendingCancel,
  activity,
  onClose,
  onReschedule,
  onRsvp,
  onAttach,
  onRemoveAttachment,
  onCancel,
}: {
  event: AgEvent;
  calendarName?: string;
  color: string | null;
  pending: boolean;
  pendingCancel: boolean;
  activity: ActivityEntry[];
  onClose: () => void;
  onReschedule: (id: string, s: string, e: string) => Promise<VaultOutcome | undefined>;
  onRsvp: (id: string, partyId: string, partstat: string) => void;
  onAttach: (id: string) => void;
  onRemoveAttachment: (aid: string) => Promise<VaultOutcome | undefined>;
  onCancel: (id: string) => void;
}) {
  const ev = event;
  const [startVal, setStartVal] = useState(toLocalInput(ev.dtstart));
  const [endVal, setEndVal] = useState(toLocalInput(ev.dtend ?? ev.dtstart));
  const [saving, setSaving] = useState(false);
  const [formNotice, setFormNotice] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);

  const handleStartChange = (e: ChangeEvent<HTMLInputElement>) => {
    const nextStr = e.target.value;
    const prevStart = new Date(startVal);
    const prevEnd = new Date(endVal);
    const next = new Date(nextStr);
    if (!Number.isNaN(next.getTime())) {
      const dur =
        !Number.isNaN(prevStart.getTime()) &&
        !Number.isNaN(prevEnd.getTime()) &&
        prevEnd > prevStart
          ? prevEnd.getTime() - prevStart.getTime()
          : 3600000;
      setEndVal(toLocalInput(new Date(next.getTime() + dur)));
    }
    setStartVal(nextStr);
  };

  const submitReschedule = async () => {
    const dtstart = toIsoUtc(startVal);
    const dtend = toIsoUtc(endVal);
    if (!dtstart || !dtend) {
      setFormNotice('Pick both a start and an end.');
      return;
    }
    if (dtend < dtstart) {
      setFormNotice('The end must come after the start.');
      return;
    }
    setSaving(true);
    const outcome = await onReschedule(ev.event_id, dtstart, dtend);
    setSaving(false);
    if (
      outcome?.status === 'executed' ||
      outcome?.status === 'parked' ||
      outcome?.status === 'queued' ||
      outcome?.status === 'in-flight'
    ) {
      onClose();
      return;
    }
    setFormNotice(outcomeMessage(outcome) ?? 'Something went wrong.');
  };

  const handleCancelClick = () => {
    if (pendingCancel) return;
    const btn = cancelRef.current;
    if (!btn) return;
    if (!armConfirm(btn, { armedLabel: 'Ask to cancel?' })) return;
    onCancel(ev.event_id);
  };

  const statusLabel = pendingCancel
    ? 'Cancel pending'
    : ev.status === 'tentative'
      ? 'Tentative'
      : 'Confirmed';
  const attendees = ev.attendees ?? [];
  const repeats = repeatLabel(ev.rrule);

  return (
    <div
      className={styles.drawerBackdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={pending ? `${styles.drawer} kit-pending` : styles.drawer}>
        <div
          className={styles.drawerBar}
          style={{ background: color ?? undefined }}
          aria-hidden="true"
        />
        <div className={styles.drawerHead}>
          <div className={styles.drawerHeadText}>
            <h2 className={styles.drawerTitle}>{ev.summary}</h2>
            <p className={styles.drawerRange}>{fmtRange(ev)}</p>
          </div>
          <button type="button" className="kit-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon svg={I.close} />
          </button>
        </div>
        <div className={styles.drawerMeta}>
          <span className={styles.drawerCal}>
            <CalDot color={color} /> {calendarName ?? 'No calendar'}
          </span>
          <span
            className={styles.badge}
            data-tone={pendingCancel ? 'warn' : ev.status === 'tentative' ? 'muted' : 'accent'}
          >
            {statusLabel}
          </span>
          {repeats ? (
            <span className={styles.badge} data-tone="muted" title={ev.rrule ?? undefined}>
              <Icon svg={I.repeat} /> {repeats}
            </span>
          ) : null}
        </div>

        <div className={styles.drawerBody}>
          {ev.description ? <p className={styles.drawerDesc}>{ev.description}</p> : null}

          {ev.conferencing_uri ? (
            <a
              className={`kit-btn primary ${styles.flex} ag-join-btn`}
              href={ev.conferencing_uri}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Icon svg={I.video} /> Join video call
            </a>
          ) : null}

          {attendees.length ? (
            <>
              <div className="ag-eyebrow-label">Guests</div>
              <div className={styles.guests}>
                {attendees.map((a) => (
                  <GuestRow
                    key={a.party_id}
                    attendee={a}
                    onPick={(partstat) => onRsvp(ev.event_id, a.party_id, partstat)}
                  />
                ))}
              </div>
            </>
          ) : null}

          <div className="ag-eyebrow-label">Reschedule</div>
          {ev.rrule ? (
            <p className="muted small">
              Moving a repeating event shifts the whole series, not just this occurrence.
            </p>
          ) : null}
          <div className={styles.reschedule}>
            <label className="ag-field-row">
              <span>Start</span>
              <input type="datetime-local" value={startVal} onChange={handleStartChange} />
            </label>
            <label className="ag-field-row">
              <span>End</span>
              <input
                type="datetime-local"
                value={endVal}
                onChange={(e) => setEndVal(e.target.value)}
              />
            </label>
            <button
              type="button"
              className={`kit-btn primary ${styles.rescheduleBtn}`}
              disabled={saving}
              onClick={submitReschedule}
            >
              Move event
            </button>
          </div>
          {formNotice ? (
            <p className={`${shared.formNotice} muted small`} role="status">
              {formNotice}
            </p>
          ) : null}

          <div className="ag-eyebrow-label">Activity</div>
          <div className={styles.activity}>
            {activity.length === 0 ? (
              <p className={`muted small ${styles.activityEmpty}`}>No activity yet this session.</p>
            ) : (
              activity.map((a, i) => (
                <div className={styles.activityItem} key={i}>
                  <span className={styles.activityRail} aria-hidden="true" />
                  <div>
                    <div className={styles.activityText}>{a.text}</div>
                    <div className={styles.activityMeta}>
                      <span className={styles.activityDate}>{a.when}</span>
                      {a.receiptId ? <span className={styles.receiptChip}>receipt</span> : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="ag-eyebrow-label">Attachments</div>
          <AttachStrip event={ev} onRemove={onRemoveAttachment} />
        </div>

        <div className={styles.drawerFoot}>
          <button
            type="button"
            className={`kit-btn ${styles.flex}`}
            onClick={() => onAttach(ev.event_id)}
          >
            <Icon svg={I.attach} /> Attach
          </button>
          <button
            type="button"
            className={`kit-btn danger ${styles.flex}`}
            ref={cancelRef}
            disabled={pendingCancel}
            onClick={handleCancelClick}
          >
            {pendingCancel ? 'Cancellation pending' : 'Ask to cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
