import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";

import { KitModal } from "../../_shared/KitModal.tsx";
import { displayText, safeExternalUrl } from "../../_shared/untrusted.ts";
import { needsScopePanel, occurrenceEdit } from "../edits.ts";
import type { EditScope } from "../edits.ts";
import { eventBounds, toLocalInput } from "../format.ts";
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
  event: AgEvent | null;
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
  const titleRef = useRef<HTMLInputElement | null>(null);

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
    titleRef.current?.focus();
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
  const bounds = eventBounds(startVal, endVal, allDay);
  const conferencingUri = safeExternalUrl(conferencing)
    ? conferencing
    : undefined;

  const commitNew = (): void => {
    props.onCreate({
      summary,
      ...bounds,
      calendar_id: calendarId,
      attendee_party_ids: [...invited],
      reminders,
      ...(rrule ? { rrule } : {}),
      ...(conferencingUri ? { conferencing_uri: conferencingUri } : {}),
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
          dtstart: bounds.dtstart,
          dtend: bounds.dtend,
          summary,
          recurrence_semantics: bounds.recurrence_semantics,
          calendar_id: calendarId,
          reminders,
          attendee_party_ids: [...invited],
          ...(conferencingUri ? { conferencing_uri: conferencingUri } : {}),
        },
      });
      if (payload) props.onEditOccurrence(payload);
      return;
    }
    props.onEdit({
      event_id: ev.event_id,
      summary,
      ...bounds,
      calendar_id: calendarId,
      attendee_party_ids: [...invited],
      reminders,
      ...(rrule ? { rrule } : { clear_rrule: true as const }),
      ...(conferencingUri
        ? { conferencing_uri: conferencingUri }
        : { clear_conferencing: true as const }),
    });
  };

  const onSave = (): void => {
    if (!ev) {
      commitNew();
      return;
    }
    if (needsScopePanel(ev)) {
      setScopeOpen(true);
      return;
    }
    commitEdit(null);
  };

  const onSkip = (scope: EditScope): void => {
    if (!ev) return;
    const payload = occurrenceEdit({ event: ev, scope, intent: "skip" });
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
      <KitModal
        layer="top"
        className={`kit-modal ${styles.editor}`}
        ariaModal
        labelledBy="agendaEditorTitle"
        onDismiss={props.onClose}
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
      </KitModal>
    </div>
  );
}
