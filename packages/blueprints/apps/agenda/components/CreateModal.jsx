// The create-event composer: title, start/end (end tracks start, preserving
// duration), a calendar chip picker, a description → Propose event (lands
// tentative; the vault refuses conflicts). Opening from a day/slot click
// prefills the time via `prefill`.
import { useEffect, useRef, useState } from '../react-core.min.js';
import { outcomeMessage } from '../kit.js';
import { colorForCalendar, nextHalfHour, toIsoUtc, toLocalInput } from '../format.js';
import { I } from '../icons.js';
import { CalDot, Icon } from './Shared.jsx';

export function CreateModal({ calendars, prefill, onClose, onSubmit }) {
  const start0 = prefill?.start ?? nextHalfHour();
  const end0 = prefill?.end ?? new Date(start0.getTime() + 3600000);
  const [summary, setSummary] = useState('');
  const [startVal, setStartVal] = useState(toLocalInput(start0));
  const [endVal, setEndVal] = useState(toLocalInput(end0));
  const [calendarId, setCalendarId] = useState(calendars[0]?.calendar_id ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [formNotice, setFormNotice] = useState('');
  const titleRef = useRef(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const handleStartChange = (e) => {
    const nextStr = e.target.value;
    const prevStart = new Date(startVal);
    const prevEnd = new Date(endVal);
    const next = new Date(nextStr);
    if (!Number.isNaN(next.getTime())) {
      const dur =
        !Number.isNaN(prevStart.getTime()) && !Number.isNaN(prevEnd.getTime()) && prevEnd > prevStart
          ? prevEnd.getTime() - prevStart.getTime()
          : 3600000;
      setEndVal(toLocalInput(new Date(next.getTime() + dur)));
    }
    setStartVal(nextStr);
  };

  const submit = async () => {
    const title = summary.trim();
    if (!title) {
      setFormNotice('Give the event a title.');
      return;
    }
    const dtstart = toIsoUtc(startVal);
    const dtend = toIsoUtc(endVal);
    if (!dtstart || !dtend) {
      setFormNotice('Pick a start and an end.');
      return;
    }
    if (dtend < dtstart) {
      setFormNotice('Pick a start and a later end.');
      return;
    }
    if (!calendarId) {
      setFormNotice('Pick a calendar.');
      return;
    }
    setBusy(true);
    const outcome = await onSubmit({
      summary: title,
      dtstart,
      dtend,
      calendar_id: calendarId,
      ...(description.trim() ? { description: description.trim() } : {}),
    });
    setBusy(false);
    if (outcome?.status === 'executed' || outcome?.status === 'denied') {
      onClose();
      return;
    }
    setFormNotice(outcomeMessage(outcome) ?? 'Something went wrong.');
  };

  return (
    <div
      className="kit-modal-back"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kit-modal ag-create-modal" role="dialog" aria-modal="true" aria-labelledby="createEventTitle">
        <div className="ag-create-head">
          <span id="createEventTitle" className="ag-create-heading">
            New event
          </span>
          <button type="button" className="kit-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon svg={I.close} />
          </button>
        </div>
        <div className="ag-create-body">
          <input
            ref={titleRef}
            type="text"
            className="ag-create-title"
            placeholder="Add title"
            aria-label="Event title"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <div className="ag-create-times">
            <label className="ag-field-row">
              <span>Start</span>
              <input type="datetime-local" value={startVal} onChange={handleStartChange} />
            </label>
            <label className="ag-field-row">
              <span>End</span>
              <input type="datetime-local" value={endVal} onChange={(e) => setEndVal(e.target.value)} />
            </label>
          </div>
          <div>
            <div className="ag-eyebrow-label">Calendar</div>
            {calendars.length ? (
              <div className="ag-cal-chips">
                {calendars.map((c) => {
                  const color = colorForCalendar(c, c.calendar_id);
                  return (
                    <button
                      key={c.calendar_id}
                      type="button"
                      className="ag-cal-chip"
                      aria-pressed={String(calendarId === c.calendar_id)}
                      onClick={() => setCalendarId(c.calendar_id)}
                    >
                      <CalDot color={color} />
                      {c.name ?? 'Calendar'}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="muted small">
                The vault has no calendars yet — import an .ics file through the vault's ingest to create one.
              </p>
            )}
          </div>
          <textarea
            className="ag-create-desc"
            placeholder="Add a description"
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {formNotice ? (
            <p className="ag-form-notice muted small" role="status">
              {formNotice}
            </p>
          ) : null}
        </div>
        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="kit-btn primary" disabled={busy || !calendars.length} onClick={submit}>
            Propose event
          </button>
        </div>
      </div>
    </div>
  );
}
