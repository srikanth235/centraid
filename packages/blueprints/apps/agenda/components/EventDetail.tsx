// The detail panel — a column BESIDE the canvas, never over it, so the next
// row can be reached without dismissing the description first.
//
// It carries the four things an event is asked about: what it is, who is
// coming (and the member's own RSVP), what is held about it, and the two
// verbs — Edit, and Ask to cancel.
//
// PARKED CANCEL IS A STATE, NOT AN ERROR. Cancelling is medium-risk, so the
// vault HOLDS the ask for the owner instead of executing it. The event stays
// on the agenda, this panel says exactly what is held, and the way on is
// Approvals — the owner's own surface. There is deliberately no unpark control
// here: the vault's release door (`confirmVaultParked`) is the owner's, an app
// cannot reach it, and a button that could not act would be worse than the
// sentence that says who decides.
import type { ReactNode } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { eventTitle, fmtTime } from "../format.ts";
import type { RsvpAnswer } from "../edits.ts";
import type { AgEvent, Attendee } from "../types.ts";
import {
  ATTACH,
  CANCEL_EVENT,
  CLOSE,
  DETACH,
  FIELD_CALENDAR,
  FIELD_GUESTS,
  FIELD_REPEAT,
  FIELD_WHERE,
  PARKED_CANCEL_BODY,
  PARKED_CANCEL_REVIEW,
  PARKED_CANCEL_TITLE,
  RSVP_AWAITING,
  RSVP_MAYBE,
  RSVP_NO,
  RSVP_QUESTION,
  RSVP_YES,
  QUICK_EDIT,
} from "../view-copy.ts";
import { isUnanswered, myAttendance } from "../views.ts";
import { CalendarDot, JoinLink, Num, Safe } from "./Shared.tsx";

import styles from "./EventDetail.module.css";

const RSVP_LABELS: Readonly<Record<RsvpAnswer, string>> = {
  accepted: RSVP_YES,
  declined: RSVP_NO,
  tentative: RSVP_MAYBE,
};

export interface EventDetailProps {
  event: AgEvent;
  calendarName: string | undefined;
  hue: string | null;
  /** The row's held write, read from the shared overlay by the caller. */
  pending: { status: string; action: string } | undefined;
  onClose: () => void;
  onEdit: () => void;
  onRsvp: (partyId: string, answer: RsvpAnswer) => void;
  onCancel: () => void;
  onAttach: () => void;
  onDetach: (attachmentId: string) => void;
}

function GuestRow({ guest }: { guest: Attendee }): ReactNode {
  return (
    <li className={styles.guest}>
      <span className={styles.guestName}>
        <Safe value={guest.name} />
      </span>
      <span className={styles.guestState}>
        {isUnanswered(guest.partstat)
          ? RSVP_AWAITING
          : (RSVP_LABELS[guest.partstat as RsvpAnswer] ??
            displayText(guest.partstat))}
      </span>
    </li>
  );
}

export function EventDetail(props: EventDetailProps): ReactNode {
  const ev = props.event;
  const mine = myAttendance(ev);
  // The owner's own door. It is absent on a host that mounts no approvals
  // surface, and then the panel says where the decision lives instead of
  // drawing a control that goes nowhere.
  const handleReviewInApprovals = window.centraid.openApprovals;
  const heldCancel =
    props.pending?.action === "cancel-event" &&
    (props.pending.status === "parked" ||
      props.pending.status === "queued" ||
      props.pending.status === "sending");

  return (
    <aside className={styles.detail} aria-label={eventTitle(ev)}>
      <header className={styles.head}>
        <CalendarDot hue={props.hue} />
        <h2 className={styles.title}>
          <Safe value={eventTitle(ev)} />
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

      <p className={styles.when}>
        <Num>
          {fmtTime(ev.dtstart)}
          {ev.dtend ? ` – ${fmtTime(ev.dtend)}` : ""}
        </Num>
      </p>

      {ev.description ? (
        <p className={styles.description}>
          <Safe value={ev.description} />
        </p>
      ) : null}

      <dl className={styles.facts}>
        {props.calendarName ? (
          <div className={styles.fact}>
            <dt>{FIELD_CALENDAR}</dt>
            <dd>
              <Safe value={props.calendarName} />
            </dd>
          </div>
        ) : null}
        {/* The ONE recurrence sentence. The rule that produced it never
            reaches a member's screen. */}
        {ev.recurrence_summary ? (
          <div className={styles.fact}>
            <dt>{FIELD_REPEAT}</dt>
            <dd>
              <Safe value={ev.recurrence_summary} />
            </dd>
          </div>
        ) : null}
        {ev.conferencing_uri ? (
          <div className={styles.fact}>
            <dt>{FIELD_WHERE}</dt>
            <dd>
              {/* An unsafe scheme draws nothing rather than a dead link. */}
              <JoinLink uri={ev.conferencing_uri} label={FIELD_WHERE} />
            </dd>
          </div>
        ) : null}
      </dl>

      {/* The member's own answer, projected straight back into the list above
          the moment it is pressed. */}
      {mine ? (
        <section className={styles.rsvp} aria-label={RSVP_QUESTION}>
          <h3 className={styles.sectionLabel}>{RSVP_QUESTION}</h3>
          <fieldset className="kit-seg" aria-label={RSVP_QUESTION}>
            {(Object.keys(RSVP_LABELS) as RsvpAnswer[]).map((answer) => (
              <button
                key={answer}
                type="button"
                aria-pressed={mine.partstat === answer}
                onClick={() => props.onRsvp(mine.party_id, answer)}
              >
                {RSVP_LABELS[answer]}
              </button>
            ))}
          </fieldset>
        </section>
      ) : null}

      {(ev.attendees ?? []).length > 0 ? (
        <section aria-label={FIELD_GUESTS}>
          <h3 className={styles.sectionLabel}>{FIELD_GUESTS}</h3>
          <ul className={styles.guests}>
            {(ev.attendees ?? []).map((guest) => (
              <GuestRow key={guest.party_id} guest={guest} />
            ))}
          </ul>
        </section>
      ) : null}

      {(ev.attachments ?? []).length > 0 ? (
        <ul className={styles.attachments}>
          {(ev.attachments ?? []).map((attachment) => (
            <li key={attachment.attachment_id} className={styles.attachment}>
              <span className={styles.attachmentName}>
                <Safe value={attachment.title ?? attachment.media_type ?? ""} />
              </span>
              <button
                type="button"
                className="kit-btn"
                onClick={() => props.onDetach(attachment.attachment_id)}
              >
                {DETACH}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* PARKED CANCEL. What the vault holds, and who releases it. */}
      {heldCancel ? (
        <section className={styles.parked} aria-label={PARKED_CANCEL_TITLE}>
          <h3 className={styles.sectionLabel}>{PARKED_CANCEL_TITLE}</h3>
          <p className={styles.parkedBody}>{PARKED_CANCEL_BODY}</p>
          {handleReviewInApprovals ? (
            <button
              type="button"
              className="kit-btn"
              onClick={handleReviewInApprovals}
            >
              {PARKED_CANCEL_REVIEW}
            </button>
          ) : (
            <p className={styles.parkedBody}>{PARKED_CANCEL_REVIEW}</p>
          )}
        </section>
      ) : null}

      {/* The shared held-write chip with View / Retry / Discard, so every app
          says the same thing about a write that has not landed. */}
      <PendingWriteActions
        row={ev as unknown as Record<string, unknown>}
        onEdit={props.onEdit}
      />

      <footer className={styles.foot}>
        <button type="button" className="kit-btn" onClick={props.onAttach}>
          {ATTACH}
        </button>
        {/* Destructive takes the OUTLINE, never the fill. */}
        <button
          type="button"
          className="kit-btn destructive"
          onClick={props.onCancel}
        >
          {CANCEL_EVENT}
        </button>
        {/* The panel's one filled control: the way to change this event. A
            repeating one opens the scope panel on the way, so this button
            never decides the scope on the member's behalf. */}
        <button type="button" className="kit-btn primary" onClick={props.onEdit}>
          {QUICK_EDIT}
        </button>
      </footer>
    </aside>
  );
}
