// The editor — one modal for both the new event and the edit, because they
// are the same seven fields and a second composer is a second product.
//
// It carries: title, the all-day switch (which is the event's recurrence
// SEMANTICS, not a display toggle), start and end, the repeat picker, the
// calendar, the guests with their RSVP state, and the reminder lead.
//
// REPEAT SHOWS THE SUMMARY, NEVER THE RULE. The event's current repetition is
// read from `recurrence_summary`, the one sentence the shared summariser
// produced in the query. The picker's own options are named in words too; the
// rule each one carries is a value on its way to `edit-event` and is never
// painted.
//
// A REPEATING EVENT OPENS THE SCOPE PANEL ON SAVE. Three answers, none of them
// filled: which occurrences this change is about is the member's decision and
// the panel does not have a recommendation.
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";

import { displayText, safeExternalUrl } from "../../_shared/untrusted.ts";
import { needsScopePanel, occurrenceEdit } from "../edits.ts";
import type { EditScope } from "../edits.ts";
import { toIsoUtc, toLocalInput } from "../format.ts";
import type {
  AgEvent,
  Calendar,
  CreatePayload,
  EventEditPayload,
  OccurrenceEditPayload,
  PartyOption,
} from "../types.ts";
import {
  CLOSE,
  EDITOR_TITLE,
  FIELD_ALL_DAY,
  FIELD_CALENDAR,
  FIELD_ENDS,
  FIELD_GUESTS,
  FIELD_REMINDER,
  FIELD_REPEAT,
  FIELD_STARTS,
  FIELD_SUMMARY,
  FIELD_WHERE,
  NEW_EVENT,
  REMINDER_LEADS,
  REMINDER_NONE,
  REPEAT_CHOICES,
  REPEAT_NEVER,
  SAVE,
  SCOPE_FUTURE,
  SCOPE_OCCURRENCE,
  SCOPE_QUESTION,
  SCOPE_SERIES,
  SCOPE_SKIP,
  SCOPE_TITLE,
} from "../view-copy.ts";

import styles from "./EventEditor.module.css";

export interface EventEditorProps {
  /** The event being changed, or null while composing a new one. */
  event: AgEvent | null;
  /** The slot a quick add started from, when there is one. */
  draft?: { start: Date; end: Date; title: string } | undefined;
  calendars: readonly Calendar[];
  parties: readonly PartyOption[];
  onClose: () => void;
  onCreate: (payload: CreatePayload) => void;
  onEdit: (payload: EventEditPayload) => void;
  onEditOccurrence: (payload: OccurrenceEditPayload) => void;
}

const SCOPE_LABELS: readonly { scope: EditScope; label: string }[] = [
  { scope: "occurrence", label: SCOPE_OCCURRENCE },
  { scope: "future", label: SCOPE_FUTURE },
  { scope: "series", label: SCOPE_SERIES },
];

function firstReminder(json: string | null | undefined): number | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { minutes_before?: number }[];
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    return typeof first?.minutes_before === "number"
      ? first.minutes_before
      : null;
  } catch {
    return null;
  }
}

export function EventEditor(props: EventEditorProps): ReactNode {
  const ev = props.event;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  /** Restored on close: focus goes back to whatever opened the editor. */
  const priorFocus = useRef<HTMLElement | null>(null);

  const [summary, setSummary] = useState(
    () => ev?.summary ?? props.draft?.title ?? ""
  );
  const [allDay, setAllDay] = useState(
    () => ev?.recurrence_semantics === "all-day"
  );
  const [startVal, setStartVal] = useState(() =>
    toLocalInput(ev?.dtstart ?? props.draft?.start ?? new Date())
  );
  const [endVal, setEndVal] = useState(() =>
    toLocalInput(ev?.dtend ?? props.draft?.end ?? new Date())
  );
  const [rrule, setRrule] = useState(() => ev?.rrule ?? "");
  const [calendarId, setCalendarId] = useState(
    () => ev?.calendar_id ?? props.calendars[0]?.calendar_id ?? ""
  );
  const [conferencing, setConferencing] = useState(
    () => ev?.conferencing_uri ?? ""
  );
  const [reminder, setReminder] = useState<number | null>(() =>
    firstReminder(ev?.reminders_json)
  );
  const [invited, setInvited] = useState<Set<string>>(
    () => new Set((ev?.attendees ?? []).map((guest) => guest.party_id))
  );
  const [scopeOpen, setScopeOpen] = useState(false);

  useEffect(() => {
    priorFocus.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    titleRef.current?.focus();
    return () => {
      dialog?.close();
      priorFocus.current?.focus();
    };
  }, []);

  const toggleGuest = (partyId: string): void => {
    setInvited((current) => {
      const next = new Set(current);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  };

  const reminders = reminder === null ? [] : [{ minutes_before: reminder }];
  const semantics = allDay ? "all-day" : "zoned";

  const commitNew = (): void => {
    props.onCreate({
      summary,
      dtstart: toIsoUtc(startVal),
      dtend: toIsoUtc(endVal),
      calendar_id: calendarId,
      recurrence_semantics: semantics,
      attendee_party_ids: [...invited],
      reminders,
      ...(rrule ? { rrule } : {}),
      // An unsafe scheme never leaves this form: the same allowlist that
      // refuses to paint it refuses to store it.
      ...(safeExternalUrl(conferencing)
        ? { conferencing_uri: conferencing }
        : {}),
    });
  };

  const commitEdit = (scope: EditScope | null): void => {
    if (!ev) return;
    if (scope && scope !== "series") {
      const payload = occurrenceEdit({
        event: ev,
        scope,
        intent: "edit",
        changes: {
          dtstart: toIsoUtc(startVal),
          dtend: toIsoUtc(endVal),
          summary,
        },
      });
      if (payload) props.onEditOccurrence(payload);
      return;
    }
    props.onEdit({
      event_id: ev.event_id,
      summary,
      dtstart: toIsoUtc(startVal),
      dtend: toIsoUtc(endVal),
      recurrence_semantics: semantics,
      calendar_id: calendarId,
      attendee_party_ids: [...invited],
      reminders,
      ...(rrule ? { rrule } : { clear_rrule: true as const }),
      ...(safeExternalUrl(conferencing)
        ? { conferencing_uri: conferencing }
        : { clear_conferencing: true as const }),
    });
  };

  const onSave = (): void => {
    if (!ev) {
      commitNew();
      return;
    }
    // The scope question is asked ONLY where it has an answer that matters.
    if (needsScopePanel(ev)) {
      setScopeOpen(true);
      return;
    }
    commitEdit(null);
  };

  const onSkip = (scope: EditScope): void => {
    if (!ev) return;
    const payload = occurrenceEdit({ event: ev, scope, intent: "skip" });
    // `null` means the product does not offer that pairing, so nothing is
    // sent and no control was drawn for it above.
    if (payload) props.onEditOccurrence(payload);
  };

  const heading = ev ? EDITOR_TITLE : NEW_EVENT;

  return (
    <div className="kit-modal-back">
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label={CLOSE}
        onClick={props.onClose}
      />
      <dialog
        ref={dialogRef}
        className={`kit-modal ${styles.editor}`}
        aria-modal="true"
        aria-labelledby="agendaEditorTitle"
        onCancel={props.onClose}
      >
        <header className={styles.head}>
          <h2 id="agendaEditorTitle" className={styles.heading}>
            {heading}
          </h2>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label={CLOSE}
            onClick={props.onClose}
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <label className={styles.field}>
            <span className={styles.label}>{FIELD_SUMMARY}</span>
            <input
              ref={titleRef}
              type="text"
              className="kit-input"
              value={summary}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setSummary(event.target.value)
              }
            />
          </label>

          {/* THE ALL-DAY SWITCH IS THE EVENT'S SEMANTICS. It changes what the
              vault stores about the event's relationship to a clock, not how
              this app draws it. */}
          <label className={styles.switchRow}>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setAllDay(event.target.checked)
              }
            />
            <span>{FIELD_ALL_DAY}</span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{FIELD_STARTS}</span>
            <input
              type={allDay ? "date" : "datetime-local"}
              className="kit-input"
              value={allDay ? startVal.slice(0, 10) : startVal}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setStartVal(
                  allDay ? `${event.target.value}T00:00` : event.target.value
                )
              }
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{FIELD_ENDS}</span>
            <input
              type={allDay ? "date" : "datetime-local"}
              className="kit-input"
              value={allDay ? endVal.slice(0, 10) : endVal}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setEndVal(
                  allDay ? `${event.target.value}T23:59` : event.target.value
                )
              }
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{FIELD_REPEAT}</span>
            <select
              className="kit-input"
              value={rrule}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setRrule(event.target.value)
              }
            >
              <option value="">{REPEAT_NEVER}</option>
              {REPEAT_CHOICES.map((choice) => (
                <option key={choice.rrule} value={choice.rrule}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          {/* The event's CURRENT repetition, in the one sentence the shared
              summariser produced. Never the rule. */}
          {ev?.recurrence_summary ? (
            <p className={styles.summaryLine}>
              {displayText(ev.recurrence_summary)}
            </p>
          ) : null}

          <label className={styles.field}>
            <span className={styles.label}>{FIELD_CALENDAR}</span>
            <select
              className="kit-input"
              value={calendarId}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setCalendarId(event.target.value)
              }
            >
              {props.calendars.map((calendar) => (
                <option key={calendar.calendar_id} value={calendar.calendar_id}>
                  {displayText(calendar.name ?? calendar.calendar_id)}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{FIELD_REMINDER}</span>
            <select
              className="kit-input"
              value={reminder === null ? "" : String(reminder)}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setReminder(
                  event.target.value === "" ? null : Number(event.target.value)
                )
              }
            >
              <option value="">{REMINDER_NONE}</option>
              {REMINDER_LEADS.map((lead) => (
                <option key={lead.minutes} value={String(lead.minutes)}>
                  {lead.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{FIELD_WHERE}</span>
            <input
              type="url"
              className="kit-input"
              value={conferencing}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setConferencing(event.target.value)
              }
            />
          </label>

          <fieldset className={styles.guests}>
            <legend className={styles.label}>{FIELD_GUESTS}</legend>
            {props.parties.map((party) => {
              const answered = (ev?.attendees ?? []).find(
                (guest) => guest.party_id === party.party_id
              );
              return (
                <label key={party.party_id} className={styles.guestRow}>
                  <input
                    type="checkbox"
                    checked={invited.has(party.party_id)}
                    onChange={() => toggleGuest(party.party_id)}
                  />
                  <span className={styles.guestName}>
                    {displayText(party.name)}
                  </span>
                  {answered ? (
                    <span className={styles.guestState}>
                      {displayText(answered.partstat)}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </fieldset>
        </div>

        {/* THE SCOPE PANEL. Three answers, no filled control among them. */}
        {scopeOpen && ev ? (
          <section className={styles.scope} aria-label={SCOPE_TITLE}>
            <h3 className={styles.scopeTitle}>{SCOPE_TITLE}</h3>
            <p className={styles.scopeQuestion}>{SCOPE_QUESTION}</p>
            <div className={styles.scopeChoices}>
              {SCOPE_LABELS.map(({ scope, label }) => (
                <button
                  key={scope}
                  type="button"
                  className="kit-btn"
                  onClick={() => commitEdit(scope)}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* Skip is occurrence-shaped. `occurrenceEdit` refuses to skip a
                whole series, so no control offers it. */}
            <button
              type="button"
              className="kit-btn"
              onClick={() => onSkip("occurrence")}
            >
              {SCOPE_SKIP}
            </button>
          </section>
        ) : null}

        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={props.onClose}>
            {CLOSE}
          </button>
          {scopeOpen ? null : (
            <button type="button" className="kit-btn primary" onClick={onSave}>
              {SAVE}
            </button>
          )}
        </div>
      </dialog>
    </div>
  );
}
