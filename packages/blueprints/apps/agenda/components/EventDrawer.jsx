// The right slide-over event detail drawer. Mounted keyed by event_id at the
// call site (app.jsx) so switching events remounts this component fresh —
// local reschedule-draft state always starts from the newly opened event, no
// stale-buffer bugs. Guests render only when the event carries an `attendees`
// list — upcoming.js/search.js join schedule_attendee → core_party per event
// (issue #337); the "You" row (is_you) gets RSVP controls, other guests show
// their PARTSTAT.
import { useEffect, useRef, useState } from '../react-core.min.js';
import { armConfirm, outcomeMessage, renderAttachments } from '../kit.js';
import { fmtRange, initials, toIsoUtc, toLocalInput } from '../format.js';
import { I } from '../icons.js';
import { CalDot, Icon } from './Shared.jsx';

const REPEAT_LABEL = {
  DAILY: 'Repeats daily',
  WEEKLY: 'Repeats weekly',
  MONTHLY: 'Repeats monthly',
  YEARLY: 'Repeats yearly',
};

/** A short human label for a stored rrule's FREQ — "Repeats weekly" etc. */
function repeatLabel(rrule) {
  const match = /FREQ=([A-Z]+)/.exec(String(rrule ?? ''));
  return match ? (REPEAT_LABEL[match[1]] ?? 'Repeats') : null;
}

const RSVP_OPTIONS = [
  ['accepted', 'Going', I.check],
  ['tentative', 'Maybe', I.maybe],
  ['declined', 'Decline', I.decline],
];
const PARTSTAT_LABEL = {
  accepted: 'Going',
  declined: 'No',
  tentative: 'Maybe',
  'needs-action': 'Invited',
};

function GuestRow({ attendee, onPick }) {
  if (attendee.is_you) {
    return (
      <div className="ag-guest-row">
        <span className="ag-guest-avatar">You</span>
        <span className="ag-guest-name">You</span>
        <div className="ag-guest-opts">
          {RSVP_OPTIONS.map(([value, title, svg]) => (
            <button
              key={value}
              type="button"
              className="ag-guest-opt"
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
    <div className="ag-guest-row">
      <span className="ag-guest-avatar">{initials(attendee.name)}</span>
      <span className="ag-guest-name">{attendee.name}</span>
      <span className="ag-guest-stat" data-stat={attendee.partstat}>
        {PARTSTAT_LABEL[attendee.partstat] ?? 'Invited'}
      </span>
    </div>
  );
}

function AttachStrip({ event, onRemove }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) renderAttachments(ref.current, event.attachments ?? [], onRemove);
  }, [event.attachments, onRemove]);
  if (!event.attachments?.length) return null;
  return <div className="kit-attach-strip ag-drawer-attach" ref={ref} />;
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
}) {
  const ev = event;
  const [startVal, setStartVal] = useState(toLocalInput(ev.dtstart));
  const [endVal, setEndVal] = useState(toLocalInput(ev.dtend ?? ev.dtstart));
  const [saving, setSaving] = useState(false);
  const [formNotice, setFormNotice] = useState('');
  const cancelRef = useRef(null);

  const handleStartChange = (e) => {
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
    if (!armConfirm(cancelRef.current, { armedLabel: 'Ask to cancel?' })) return;
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
      className="ag-drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={pending ? 'ag-drawer kit-pending' : 'ag-drawer'}>
        <div className="ag-drawer-bar" style={{ background: color }} aria-hidden="true" />
        <div className="ag-drawer-head">
          <div className="ag-drawer-head-text">
            <h2 className="ag-drawer-title">{ev.summary}</h2>
            <p className="ag-drawer-range">{fmtRange(ev)}</p>
          </div>
          <button type="button" className="kit-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon svg={I.close} />
          </button>
        </div>
        <div className="ag-drawer-meta">
          <span className="ag-drawer-cal">
            <CalDot color={color} /> {calendarName ?? 'No calendar'}
          </span>
          <span
            className="ag-badge"
            data-tone={pendingCancel ? 'warn' : ev.status === 'tentative' ? 'muted' : 'accent'}
          >
            {statusLabel}
          </span>
          {repeats ? (
            <span className="ag-badge" data-tone="muted" title={ev.rrule}>
              <Icon svg={I.repeat} /> {repeats}
            </span>
          ) : null}
        </div>

        <div className="ag-drawer-body">
          {ev.description ? <p className="ag-drawer-desc">{ev.description}</p> : null}

          {ev.conferencing_uri ? (
            <a
              className="kit-btn primary ag-flex ag-join-btn"
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
              <div className="ag-guests">
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
          <div className="ag-reschedule">
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
              className="kit-btn primary ag-reschedule-btn"
              disabled={saving}
              onClick={submitReschedule}
            >
              Move event
            </button>
          </div>
          {formNotice ? (
            <p className="ag-form-notice muted small" role="status">
              {formNotice}
            </p>
          ) : null}

          <div className="ag-eyebrow-label">Activity</div>
          <div className="ag-activity">
            {activity.length === 0 ? (
              <p className="muted small ag-activity-empty">No activity yet this session.</p>
            ) : (
              activity.map((a, i) => (
                <div className="ag-activity-item" key={i}>
                  <span className="ag-activity-rail" aria-hidden="true" />
                  <div>
                    <div className="ag-activity-text">{a.text}</div>
                    <div className="ag-activity-meta">
                      <span className="ag-activity-date">{a.when}</span>
                      {a.receiptId ? <span className="ag-receipt-chip">receipt</span> : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="ag-eyebrow-label">Attachments</div>
          <AttachStrip event={ev} onRemove={onRemoveAttachment} />
        </div>

        <div className="ag-drawer-foot">
          <button type="button" className="kit-btn ag-flex" onClick={() => onAttach(ev.event_id)}>
            <Icon svg={I.attach} /> Attach
          </button>
          <button
            type="button"
            className="kit-btn danger ag-flex"
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
