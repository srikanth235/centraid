// The right slide-over event detail drawer. Mounted keyed by event_id at the
// call site (app.tsx) so switching events remounts this component fresh —
// local reschedule-draft state always starts from the newly opened event, no
// stale-buffer bugs. Guests render only when the event carries an `attendees`
// list — upcoming.ts/search.ts join schedule_attendee → core_party per event
// (issue #337); the "You" row (is_you) gets RSVP controls, other guests show
// their PARTSTAT.
import { useEffect, useRef } from "react";

import { armConfirm, renderAttachments } from "@centraid/design/elements";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText, safeExternalUrl } from "../../_shared/untrusted.ts";
import { fmtRange, initials } from "../format.ts";
import { I } from "../icons.ts";
import type {
  ActivityEntry,
  AgEvent,
  Attendee,
  Calendar,
  EventEditPayload,
  OccurrenceEditPayload,
} from "../types.ts";
import { EventEditor } from "./EventEditor.tsx";
import { CalDot, Icon } from "./Shared.tsx";

import styles from "./EventDrawer.module.css";

const REPEAT_LABEL: Record<string, string> = {
  DAILY: "Repeats daily",
  WEEKLY: "Repeats weekly",
  MONTHLY: "Repeats monthly",
  YEARLY: "Repeats yearly",
};

/** A short human label for a stored rrule's FREQ — "Repeats weekly" etc. */
function repeatLabel(rrule?: string | null): string | null {
  const match = /FREQ=(?<freq>[A-Z]+)/u.exec(String(rrule ?? ""));
  const freq = match?.groups?.freq;
  return freq ? (REPEAT_LABEL[freq] ?? "Repeats") : null;
}

const RSVP_OPTIONS: [string, string, string][] = [
  ["accepted", "Going", I.check],
  ["tentative", "Maybe", I.maybe],
  ["declined", "Decline", I.decline],
];
const PARTSTAT_LABEL: Record<string, string> = {
  accepted: "Going",
  declined: "No",
  tentative: "Maybe",
  "needs-action": "Invited",
};

function GuestRow({
  attendee,
  onPick,
}: {
  attendee: Attendee;
  onPick: (value: string) => void;
}) {
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
      <span className={styles.guestAvatar}>
        {initials(displayText(attendee.name))}
      </span>
      <span className={styles.guestName}>{displayText(attendee.name)}</span>
      <span className={styles.guestStat} data-stat={attendee.partstat}>
        {PARTSTAT_LABEL[attendee.partstat] ?? "Invited"}
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
        onRemove
      );
  }, [event.attachments, onRemove]);
  if (!event.attachments?.length) return null;
  return (
    <div className={`kit-attach-strip ${styles.drawerAttach}`} ref={ref} />
  );
}

export function EventDrawer({
  event,
  calendars,
  calendarName,
  color,
  pending,
  pendingCancel,
  activity,
  onClose,
  onEdit,
  onEditOccurrence,
  onRsvp,
  onAttach,
  onRemoveAttachment,
  onCancel,
}: {
  event: AgEvent;
  calendars: Calendar[];
  calendarName?: string;
  color: string | null;
  pending: boolean;
  pendingCancel: boolean;
  activity: ActivityEntry[];
  onClose: () => void;
  onEdit: (payload: EventEditPayload) => Promise<VaultOutcome | undefined>;
  onEditOccurrence: (
    payload: OccurrenceEditPayload
  ) => Promise<VaultOutcome | undefined>;
  onRsvp: (id: string, partyId: string, partstat: string) => void;
  onAttach: (id: string) => void;
  onRemoveAttachment: (aid: string) => Promise<VaultOutcome | undefined>;
  onCancel: (id: string) => void;
}) {
  const ev = event;
  const cancelRef = useRef<HTMLButtonElement>(null);

  const handleCancelClick = () => {
    if (pendingCancel) return;
    const btn = cancelRef.current;
    if (!btn) return;
    if (!armConfirm(btn, { armedLabel: "Ask to cancel?" })) return;
    onCancel(ev.event_id);
  };

  const statusLabel = pendingCancel
    ? "Cancel pending"
    : ev.status === "tentative"
      ? "Tentative"
      : "Confirmed";
  const attendees = ev.attendees ?? [];
  const repeats = repeatLabel(ev.rrule);
  const conferencingUrl = safeExternalUrl(ev.conferencing_uri);

  return (
    <div className={styles.drawerBackdrop}>
      {/* Click-outside-to-close, as a real button under the drawer (#573) —
          the drawer is positioned, so it paints above this. */}
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <dialog
        open
        className={pending ? `${styles.drawer} kit-pending` : styles.drawer}
        aria-modal="true"
        aria-labelledby="agenda-event-title"
      >
        <div
          className={styles.drawerBar}
          style={{ background: color ?? undefined }}
          aria-hidden="true"
        />
        <div className={styles.drawerHead}>
          <div className={styles.drawerHeadText}>
            <h2 className={styles.drawerTitle} id="agenda-event-title">
              {displayText(ev.summary)}
            </h2>
            <p className={styles.drawerRange}>{fmtRange(ev)}</p>
          </div>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon svg={I.close} />
          </button>
        </div>
        <div className={styles.drawerMeta}>
          <span className={styles.drawerCal}>
            <CalDot color={color} />{" "}
            {displayText(calendarName ?? "No calendar")}
          </span>
          <span
            className={styles.badge}
            data-tone={
              pendingCancel
                ? "warn"
                : ev.status === "tentative"
                  ? "muted"
                  : "accent"
            }
          >
            {statusLabel}
          </span>
          {repeats ? (
            <span
              className={styles.badge}
              data-tone="muted"
              title={ev.rrule ?? undefined}
            >
              <Icon svg={I.repeat} /> {repeats}
            </span>
          ) : null}
        </div>

        {pending ? (
          <PendingWriteActions row={ev as unknown as Record<string, unknown>} />
        ) : null}

        <div className={styles.drawerBody}>
          {ev.description ? (
            <p className={styles.drawerDesc}>{displayText(ev.description)}</p>
          ) : null}

          {conferencingUrl ? (
            <a
              className={`kit-btn primary ${styles.flex} ag-join-btn`}
              href={conferencingUrl}
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
                    onPick={(partstat) =>
                      onRsvp(ev.event_id, a.party_id, partstat)
                    }
                  />
                ))}
              </div>
            </>
          ) : null}

          <div className="ag-eyebrow-label">Edit event</div>
          <EventEditor
            event={ev}
            calendars={calendars}
            onEdit={onEdit}
            onEditOccurrence={onEditOccurrence}
            onSaved={onClose}
          />

          <div className="ag-eyebrow-label">Activity</div>
          <div className={styles.activity}>
            {activity.length === 0 ? (
              <p className={`muted small ${styles.activityEmpty}`}>
                No activity yet this session.
              </p>
            ) : (
              activity.map((a, i) => (
                <div className={styles.activityItem} key={i}>
                  <span className={styles.activityRail} aria-hidden="true" />
                  <div>
                    <div className={styles.activityText}>{a.text}</div>
                    <div className={styles.activityMeta}>
                      <span className={styles.activityDate}>{a.when}</span>
                      {a.receiptId ? (
                        <span className={styles.receiptChip}>receipt</span>
                      ) : null}
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
            {pendingCancel ? "Cancellation pending" : "Ask to cancel"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
