import { useMemo, useState } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { toIsoUtc, toLocalInput } from "../format.ts";
import { outcomeMessage } from "../kit.ts";
import type {
  AgEvent,
  Calendar,
  EventEditPayload,
  OccurrenceEditPayload,
  PartyOption,
} from "../types.ts";

import styles from "./EventEditor.module.css";

const EMPTY_CALENDARS: Calendar[] = [];

function parseReminders(value?: string | null): string {
  if (!value) return "";
  try {
    const rows = JSON.parse(value) as { minutes_before?: number }[];
    return rows
      .map((row) => row.minutes_before)
      .filter((minutes): minutes is number => Number.isInteger(minutes))
      .join(", ");
  } catch {
    return "";
  }
}

function reminderRows(value: string): { minutes_before: number }[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((minutes) => Number.isInteger(minutes) && minutes >= 0)
    ),
  ]
    .toSorted((left, right) => right - left)
    .map((minutes_before) => ({ minutes_before }));
}

export function EventEditor({
  event,
  calendars = EMPTY_CALENDARS,
  onEdit,
  onEditOccurrence,
  onSaved,
}: {
  event: AgEvent;
  calendars: Calendar[];
  onEdit: (payload: EventEditPayload) => Promise<VaultOutcome | undefined>;
  onEditOccurrence: (
    payload: OccurrenceEditPayload
  ) => Promise<VaultOutcome | undefined>;
  onSaved: () => void;
}) {
  const [summary, setSummary] = useState(event.summary ?? "");
  const [description, setDescription] = useState(event.description ?? "");
  const [start, setStart] = useState(toLocalInput(event.dtstart));
  const [end, setEnd] = useState(toLocalInput(event.dtend ?? event.dtstart));
  const [calendarId, setCalendarId] = useState(event.calendar_id ?? "");
  const [startTz, setStartTz] = useState(event.start_tz ?? "Etc/UTC");
  const [endTz, setEndTz] = useState(
    event.end_tz ?? event.start_tz ?? "Etc/UTC"
  );
  const [semantics, setSemantics] = useState(
    event.recurrence_semantics ?? "zoned"
  );
  const [rrule, setRrule] = useState(event.rrule ?? "");
  const [location, setLocation] = useState(event.location_place_id ?? "");
  const [conference, setConference] = useState(event.conferencing_uri ?? "");
  const [reminders, setReminders] = useState(
    parseReminders(event.reminders_json)
  );
  const [parties, setParties] = useState<PartyOption[]>([]);
  const [partiesLoaded, setPartiesLoaded] = useState(false);
  const [loadingParties, setLoadingParties] = useState(false);
  const [attendees, setAttendees] = useState(
    new Set((event.attendees ?? []).map((attendee) => attendee.party_id))
  );
  const [scope, setScope] = useState<"occurrence" | "future" | "series">(
    event.is_recurrence_instance ? "occurrence" : "series"
  );
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const loadParties = async (): Promise<void> => {
    if (loadingParties || partiesLoaded) return;
    setLoadingParties(true);
    try {
      const result = await window.centraid.read<{ parties?: PartyOption[] }>({
        query: "parties",
        input: {},
      });
      setParties(result.parties ?? []);
    } catch {
      setParties([]);
    } finally {
      setPartiesLoaded(true);
      setLoadingParties(false);
    }
  };

  const originalStart = event.original_start ?? event.dtstart;
  const canScope = Boolean(event.rrule);
  const selectedGuests = useMemo(() => [...attendees], [attendees]);

  const save = async (): Promise<void> => {
    const dtstart = toIsoUtc(start);
    const dtend = toIsoUtc(end);
    if (!summary.trim() || !dtstart || !dtend || dtend <= dtstart) {
      setNotice("Add a title and choose an end after the start.");
      return;
    }
    setSaving(true);
    const outcome =
      canScope && scope !== "series"
        ? await onEditOccurrence({
            event_id: event.event_id,
            original_start: originalStart,
            scope,
            action: "override",
            dtstart,
            dtend,
            summary: summary.trim(),
            description,
          })
        : await onEdit({
            event_id: event.event_id,
            summary: summary.trim(),
            ...(description ? { description } : { clear_description: true }),
            dtstart,
            dtend,
            start_tz: startTz,
            end_tz: endTz,
            recurrence_semantics: semantics,
            ...(rrule ? { rrule } : { clear_rrule: true }),
            ...(calendarId ? { calendar_id: calendarId } : {}),
            ...(location
              ? { location_place_id: location }
              : { clear_location: true }),
            ...(conference
              ? { conferencing_uri: conference }
              : { clear_conferencing: true }),
            reminders: reminderRows(reminders),
            attendee_party_ids: selectedGuests,
          });
    setSaving(false);
    if (
      outcome?.status === "executed" ||
      outcome?.status === "queued" ||
      outcome?.status === "in-flight"
    ) {
      onSaved();
      return;
    }
    setNotice(outcomeMessage(outcome) ?? "The edit could not be saved.");
  };

  const skip = async (): Promise<void> => {
    setSaving(true);
    const outcome = await onEditOccurrence({
      event_id: event.event_id,
      original_start: originalStart,
      scope,
      action: "skip",
    });
    setSaving(false);
    if (outcome?.status === "executed") onSaved();
    else
      setNotice(outcomeMessage(outcome) ?? "The occurrence was not skipped.");
  };

  return (
    <div className={styles.editor}>
      {canScope ? (
        <label className={`${styles.field} ${styles.scope}`}>
          <span>Apply changes to</span>
          <select
            className={styles.select}
            value={scope}
            onChange={(change) =>
              setScope(
                change.target.value as "occurrence" | "future" | "series"
              )
            }
          >
            <option value="occurrence">This occurrence</option>
            <option value="future">This and future</option>
            <option value="series">Whole series</option>
          </select>
        </label>
      ) : null}
      <input
        className={styles.title}
        value={summary}
        aria-label="Event title"
        onChange={(change) => setSummary(change.target.value)}
      />
      <textarea
        className={styles.text}
        value={description}
        aria-label="Event description"
        placeholder="Description"
        onChange={(change) => setDescription(change.target.value)}
      />
      <div className={styles.pair}>
        <label className={styles.field}>
          <span>Start</span>
          <input
            className={styles.input}
            type="datetime-local"
            value={start}
            onChange={(change) => setStart(change.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>End</span>
          <input
            className={styles.input}
            type="datetime-local"
            value={end}
            onChange={(change) => setEnd(change.target.value)}
          />
        </label>
      </div>
      <div className={styles.pair}>
        <label className={styles.field}>
          <span>Start timezone</span>
          <input
            className={styles.input}
            value={startTz}
            onChange={(change) => setStartTz(change.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>End timezone</span>
          <input
            className={styles.input}
            value={endTz}
            onChange={(change) => setEndTz(change.target.value)}
          />
        </label>
      </div>
      <div className={styles.pair}>
        <label className={styles.field}>
          <span>Time semantics</span>
          <select
            className={styles.select}
            value={semantics}
            onChange={(change) =>
              setSemantics(
                change.target.value as "zoned" | "floating" | "all-day"
              )
            }
          >
            <option value="zoned">Zoned time</option>
            <option value="floating">Floating time</option>
            <option value="all-day">All day</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>Calendar</span>
          <select
            className={styles.select}
            value={calendarId}
            onChange={(change) => setCalendarId(change.target.value)}
          >
            {calendars.map((calendar) => (
              <option key={calendar.calendar_id} value={calendar.calendar_id}>
                {displayText(calendar.name ?? "Calendar")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={styles.field}>
        <span>Repeat rule</span>
        <input
          className={styles.input}
          value={rrule}
          placeholder="FREQ=WEEKLY;BYDAY=MO"
          onChange={(change) => setRrule(change.target.value)}
        />
      </label>
      <div className={styles.pair}>
        <label className={styles.field}>
          <span>Location place ID</span>
          <input
            className={styles.input}
            value={location}
            onChange={(change) => setLocation(change.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Video call URL</span>
          <input
            className={styles.input}
            value={conference}
            onChange={(change) => setConference(change.target.value)}
          />
        </label>
      </div>
      <label className={styles.field}>
        <span>Reminder minutes (comma-separated)</span>
        <input
          className={styles.input}
          value={reminders}
          placeholder="30, 10"
          inputMode="numeric"
          onChange={(change) => setReminders(change.target.value)}
        />
      </label>
      {partiesLoaded ? (
        parties.length > 0 ? (
          <div className={styles.field}>
            <span>Attendees</span>
            <div className={styles.guestList}>
              {parties
                .filter((party) => !party.is_you)
                .map((party) => (
                  <button
                    className={styles.guest}
                    type="button"
                    key={party.party_id}
                    aria-pressed={attendees.has(party.party_id)}
                    onClick={() =>
                      setAttendees((current) => {
                        const next = new Set(current);
                        if (next.has(party.party_id))
                          next.delete(party.party_id);
                        else next.add(party.party_id);
                        return next;
                      })
                    }
                  >
                    {displayText(party.name)}
                  </button>
                ))}
            </div>
          </div>
        ) : (
          <p className="muted small">
            No other people are available to invite.
          </p>
        )
      ) : (
        <button
          type="button"
          className="kit-btn"
          disabled={loadingParties}
          onClick={() => void loadParties()}
        >
          {loadingParties ? "Loading attendees…" : "Choose attendees"}
        </button>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className="kit-btn primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {canScope && scope !== "series" ? (
          <button
            type="button"
            className="kit-btn danger"
            disabled={saving}
            onClick={() => void skip()}
          >
            Skip {scope === "future" ? "this and future" : "this occurrence"}
          </button>
        ) : null}
      </div>
      {notice ? (
        <output className={`muted small ${styles.notice}`}>{notice}</output>
      ) : null}
    </div>
  );
}
