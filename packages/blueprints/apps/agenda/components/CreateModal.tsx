// The create-event composer: title, start/end (end tracks start, preserving
// duration), a calendar chip picker, a guest picker, a description → Propose
// event (lands tentative; the vault refuses conflicts). Invited guests ride
// as `attendee_party_ids`, which the propose command turns into
// needs-action schedule_attendee rows. Opening from a day/slot click
// prefills the time via `prefill`.
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import {
  colorForCalendar,
  initials,
  nextHalfHour,
  toIsoUtc,
  toLocalInput,
} from "../format.ts";
import { I } from "../icons.ts";
import { outcomeMessage } from "../kit.ts";
import type {
  Calendar,
  CreatePayload,
  PartyOption,
  Prefill,
} from "../types.ts";
import { CalDot, Icon } from "./Shared.tsx";

import styles from "./CreateModal.module.css";
import shared from "./shared.module.css";

// Repeat picker → RFC 5545 subset the vault's recurrence engine understands
// (see @centraid/vault recurrence/rrule.ts). "None" sends no rrule at all.
const REPEAT_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "Does not repeat" },
  { value: "FREQ=DAILY", label: "Daily" },
  { value: "FREQ=WEEKLY", label: "Weekly" },
  { value: "FREQ=MONTHLY", label: "Monthly" },
  { value: "FREQ=YEARLY", label: "Yearly" },
  { value: "custom", label: "Custom RRULE…" },
];

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "Etc/UTC";
  }
}

export function CreateModal({
  calendars,
  prefill,
  onClose,
  onSubmit,
}: {
  calendars: Calendar[];
  prefill: Prefill | null;
  onClose: () => void;
  onSubmit: (payload: CreatePayload) => Promise<VaultOutcome | undefined>;
}) {
  const start0 = prefill?.start ?? nextHalfHour();
  const end0 = prefill?.end ?? new Date(start0.getTime() + 3600000);
  const [summary, setSummary] = useState("");
  const [startVal, setStartVal] = useState(toLocalInput(start0));
  const [endVal, setEndVal] = useState(toLocalInput(end0));
  const [calendarId, setCalendarId] = useState(calendars[0]?.calendar_id ?? "");
  const [description, setDescription] = useState("");
  const [repeat, setRepeat] = useState("none");
  const [customRepeat, setCustomRepeat] = useState("");
  const [semantics, setSemantics] = useState<"zoned" | "floating" | "all-day">(
    "zoned"
  );
  const [startTz, setStartTz] = useState(localTimeZone);
  const [endTz, setEndTz] = useState(localTimeZone);
  const [reminders, setReminders] = useState("10");
  const [conferencingUri, setConferencingUri] = useState("");
  // The invite directory (parties query), and the party ids currently invited.
  const [people, setPeople] = useState<PartyOption[]>([]);
  const [invited, setInvited] = useState(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [formNotice, setFormNotice] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    titleRef.current?.focus();
    return () => dialog?.close();
  }, []);

  // Load pickable guests once — you are the organizer, not a guest, so the
  // directory drops your own party. A denial just leaves the picker empty.
  useEffect(() => {
    let live = true;
    window.centraid
      .read<{ parties?: PartyOption[] }>({ query: "parties" })
      .then((res) => {
        if (live) setPeople((res?.parties ?? []).filter((p) => !p.is_you));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const toggleGuest = (partyId: string) => {
    setInvited((prev) => {
      const next = new Set(prev);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  };

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

  const submit = async () => {
    const title = summary.trim();
    if (!title) {
      setFormNotice("Give the event a title.");
      return;
    }
    const dtstart = toIsoUtc(startVal);
    const dtend = toIsoUtc(endVal);
    if (!dtstart || !dtend) {
      setFormNotice("Pick a start and an end.");
      return;
    }
    if (dtend < dtstart) {
      setFormNotice("Pick a start and a later end.");
      return;
    }
    if (!calendarId) {
      setFormNotice("Pick a calendar.");
      return;
    }
    setBusy(true);
    const rrule = repeat === "custom" ? customRepeat.trim() : repeat;
    const outcome = await onSubmit({
      summary: title,
      dtstart,
      dtend,
      calendar_id: calendarId,
      start_tz: startTz,
      end_tz: endTz,
      recurrence_semantics: semantics,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(invited.size ? { attendee_party_ids: [...invited] } : {}),
      ...(rrule === "none" || !rrule ? {} : { rrule }),
      ...(conferencingUri.trim()
        ? { conferencing_uri: conferencingUri.trim() }
        : {}),
      reminders: reminders
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 0)
        .map((minutes_before) => ({ minutes_before })),
    });
    setBusy(false);
    if (outcome?.status === "executed" || outcome?.status === "parked") {
      onClose();
      return;
    }
    if (outcome?.status === "queued" || outcome?.status === "in-flight") {
      setQueued(true);
      setFormNotice(
        "Saved on this device. It will sync automatically; no need to submit again."
      );
      return;
    }
    setFormNotice(outcomeMessage(outcome) ?? "Something went wrong.");
  };

  return (
    <div className="kit-modal-back">
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <dialog
        ref={dialogRef}
        className={`kit-modal ${styles.createModal}`}
        aria-modal="true"
        aria-labelledby="createEventTitle"
      >
        <div className={styles.createHead}>
          <span id="createEventTitle" className={styles.createHeading}>
            New event
          </span>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon svg={I.close} />
          </button>
        </div>
        <div className={styles.createBody}>
          <input
            ref={titleRef}
            type="text"
            className={styles.createTitle}
            placeholder="Add title"
            aria-label="Event title"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <div className={styles.createTimes}>
            <label className="ag-field-row">
              <span>Start</span>
              <input
                type="datetime-local"
                value={startVal}
                onChange={handleStartChange}
              />
            </label>
            <label className="ag-field-row">
              <span>End</span>
              <input
                type="datetime-local"
                value={endVal}
                onChange={(e) => setEndVal(e.target.value)}
              />
            </label>
            <label className="ag-field-row">
              <span>Repeat</span>
              <select
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                aria-label="Repeat"
              >
                {REPEAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ag-field-row">
              <span>Time</span>
              <select
                value={semantics}
                onChange={(e) =>
                  setSemantics(
                    e.target.value as "zoned" | "floating" | "all-day"
                  )
                }
              >
                <option value="zoned">Zoned</option>
                <option value="floating">Floating</option>
                <option value="all-day">All day</option>
              </select>
            </label>
          </div>
          {repeat === "custom" ? (
            <label className="ag-field-row">
              <span>RRULE</span>
              <input
                value={customRepeat}
                placeholder="FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12"
                onChange={(e) => setCustomRepeat(e.target.value)}
              />
            </label>
          ) : null}
          <div className={styles.createTimes}>
            <label className="ag-field-row">
              <span>Start zone</span>
              <input
                value={startTz}
                onChange={(e) => setStartTz(e.target.value)}
              />
            </label>
            <label className="ag-field-row">
              <span>End zone</span>
              <input value={endTz} onChange={(e) => setEndTz(e.target.value)} />
            </label>
          </div>
          <div>
            <div className="ag-eyebrow-label">Calendar</div>
            {calendars.length ? (
              <div className={styles.calChips}>
                {calendars.map((c) => {
                  const color = colorForCalendar(c, c.calendar_id);
                  return (
                    <button
                      key={c.calendar_id}
                      type="button"
                      className={styles.calChip}
                      aria-pressed={calendarId === c.calendar_id}
                      onClick={() => setCalendarId(c.calendar_id)}
                    >
                      <CalDot color={color} />
                      {c.name ?? "Calendar"}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="muted small">
                The vault has no calendars yet — import an .ics file through the
                vault's ingest to create one.
              </p>
            )}
          </div>
          {people.length ? (
            <div>
              <div className="ag-eyebrow-label">Guests</div>
              <div className={`${styles.calChips} ${styles.guestChips}`}>
                {people.map((p) => (
                  <button
                    key={p.party_id}
                    type="button"
                    className={styles.calChip}
                    aria-pressed={invited.has(p.party_id)}
                    onClick={() => toggleGuest(p.party_id)}
                  >
                    <span className={styles.guestChipAvatar}>
                      {initials(p.name)}
                    </span>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <label className="ag-field-row">
            <span>Video call</span>
            <input
              type="url"
              placeholder="Paste a meeting link"
              aria-label="Video call link"
              value={conferencingUri}
              onChange={(e) => setConferencingUri(e.target.value)}
            />
          </label>
          <label className="ag-field-row">
            <span>Reminders</span>
            <input
              inputMode="numeric"
              placeholder="30, 10"
              aria-label="Reminder minutes"
              value={reminders}
              onChange={(e) => setReminders(e.target.value)}
            />
          </label>
          <textarea
            className={styles.createDesc}
            placeholder="Add a description"
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {formNotice ? (
            <output className={`${shared.formNotice} muted small`}>
              {formNotice}
            </output>
          ) : null}
        </div>
        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="kit-btn primary"
            disabled={busy || queued || !calendars.length}
            onClick={submit}
          >
            Propose event
          </button>
        </div>
      </dialog>
    </div>
  );
}
