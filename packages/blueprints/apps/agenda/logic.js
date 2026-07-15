// Non-visual business logic: vault IO (write/act), calendar coloring, the
// session activity log and parked-write tracking, and search. `createLogic`
// closes over app.jsx's own `state`/`data` (mutated in place, never
// reassigned) plus the render/refresh entry points app.jsx defines — the
// same factory shape tasks/logic.js and notes/logic.js use.
import { debounce, outcomeMessage, toast } from './kit.js';
import { colorForCalendar } from './format.js';
import {
  clearPendingState,
  reconcilePendingChange,
  settlePendingChange,
  trackPendingOutcome,
} from './pending.js';

export function createLogic({ state, data, render, refresh }) {
  function notice(text) {
    const el = document.getElementById('noticeBanner');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  // Executed clears the banner and tells the caller to refresh; parked is
  // narrated by the caller (toast + the accent-rail/pending-chip treatment,
  // not the banner — this is a designed calm state, not an error);
  // failed/denied surface the plain-language reason in the banner.
  function narrate(outcome) {
    if (outcome?.status === 'executed') {
      notice('');
      return true;
    }
    if (outcome?.status === 'parked') {
      notice('');
      return false;
    }
    const message = outcomeMessage(outcome);
    if (message) notice(message);
    return false;
  }

  function logActivity(eventId, text, outcome) {
    if (!eventId) return;
    const list = state.activityLog.get(eventId) ?? [];
    list.unshift({ text, when: 'Today', receiptId: outcome?.receiptId ?? null });
    state.activityLog.set(eventId, list.slice(0, 20));
  }

  function clearPending() {
    clearPendingState(state);
  }

  function trackPending(eventId, kind, outcome) {
    return trackPendingOutcome(state, eventId, kind, outcome);
  }

  function settlePending(detail) {
    return settlePendingChange(state, detail);
  }

  function reconcilePending(detail, managed) {
    return reconcilePendingChange(state, detail, managed);
  }

  function colorFor(calendarId) {
    return colorForCalendar(data.calById?.get(calendarId), calendarId);
  }

  function findEvent(eventId) {
    return (data.events ?? []).find((e) => e.event_id === eventId) ?? null;
  }

  /** Like write(), but returns the raw outcome for callers that narrate + refresh themselves. */
  async function act(action, input, optimistic) {
    try {
      return await window.centraid.write({ action, input, optimistic });
    } catch (err) {
      notice(String(err?.message ?? err));
      return undefined;
    }
  }

  async function write(action, input, optimistic) {
    const outcome = await act(action, input, optimistic);
    const executed = narrate(outcome);
    if (executed || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // ---------- Event actions ----------

  async function proposeEvent(input) {
    const outcome = await write('propose', input);
    if (outcome?.status === 'executed') {
      const newId = outcome.output?.event_id;
      logActivity(newId, `Proposed on ${input.calendar_id}`, outcome);
      toast('Event proposed · receipt', {
        undoLabel: newId ? 'Undo' : undefined,
        onUndo: newId ? () => write('cancel-event', { event_id: newId }) : undefined,
      });
    } else if (outcome?.status === 'queued' || outcome?.status === 'in-flight') {
      toast('Event saved on this device — it will sync when the gateway is reachable.');
    }
    return outcome;
  }

  async function rescheduleEvent(eventId, dtstart, dtend) {
    const outcome = await write('reschedule', { event_id: eventId, dtstart, dtend });
    if (outcome?.status === 'executed') {
      logActivity(eventId, 'Rescheduled', outcome);
      toast('Event moved · receipt');
    } else if (
      outcome?.status === 'parked' ||
      outcome?.status === 'queued' ||
      outcome?.status === 'in-flight'
    ) {
      trackPending(eventId, 'reschedule', outcome);
      logActivity(
        eventId,
        outcome.status === 'parked' ? 'Move asked — parked for the owner' : 'Move saved locally',
        outcome,
      );
      toast(
        outcome.status === 'parked'
          ? 'Sent to the owner for confirmation — it stays at its current time until approved.'
          : 'Move saved on this device — it will sync when the gateway is reachable.',
        { duration: 7000 },
      );
      render();
    }
    return outcome;
  }

  async function respondRsvp(eventId, partyId, partstat) {
    const attendee = findEvent(eventId)?.attendees?.find((item) => item.party_id === partyId);
    const optimistic = attendee?.attendee_id
      ? [
          {
            op: 'upsert',
            entity: 'schedule.attendee',
            rowId: attendee.attendee_id,
            values: { partstat, responded_at: new Date().toISOString() },
            purpose: 'dpv:ServiceProvision',
          },
        ]
      : [];
    const outcome = await write(
      'rsvp',
      { event_id: eventId, party_id: partyId, partstat },
      optimistic,
    );
    if (outcome?.status === 'executed') {
      const label =
        partstat === 'accepted' ? 'Going' : partstat === 'declined' ? 'Not going' : 'Maybe';
      logActivity(eventId, `RSVP: ${label}`, outcome);
      toast(`RSVP recorded: ${label} · receipt`);
    } else if (
      outcome?.status === 'parked' ||
      outcome?.status === 'queued' ||
      outcome?.status === 'in-flight'
    ) {
      trackPending(eventId, 'rsvp', outcome);
      toast(
        outcome.status === 'parked'
          ? 'Sent to the owner for confirmation.'
          : 'RSVP saved on this device — it will sync when the gateway is reachable.',
      );
      render();
    }
    return outcome;
  }

  async function cancelEvent(eventId) {
    const outcome = await act('cancel-event', { event_id: eventId });
    const executed = narrate(outcome);
    if (
      outcome?.status === 'parked' ||
      outcome?.status === 'queued' ||
      outcome?.status === 'in-flight'
    ) {
      trackPending(eventId, 'cancel', outcome);
      logActivity(
        eventId,
        outcome.status === 'parked'
          ? 'Cancellation asked — parked for the owner'
          : 'Cancellation saved offline',
        outcome,
      );
      toast(
        outcome.status === 'parked'
          ? 'Sent to the owner for confirmation — it stays on the agenda until approved.'
          : 'Cancellation saved on this device — it will sync when the gateway is reachable.',
        { duration: 7000 },
      );
      render();
    } else if (executed) {
      logActivity(eventId, 'Cancelled', outcome);
      toast('Event cancelled · receipt');
      await refresh();
    } else if (outcome?.status === 'denied') {
      await refresh();
    } else {
      render();
    }
    return outcome;
  }

  // ---------- Attachments (kit.js renderAttachments / wireAttachInput) ----------

  let attachTarget = null;
  const setAttachTarget = (eventId) => {
    attachTarget = eventId;
  };
  const getAttachTarget = () => attachTarget;

  async function removeAttachment(attachmentId) {
    const outcome = await act('detach', { attachment_id: attachmentId });
    if (narrate(outcome) || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // ---------- Search ----------
  // Searching asks the vault, not the loaded window: the FTS5 index matches
  // over every event (summary + description), so the app never greps an
  // unbounded table in memory. A non-empty search routes the canvas to the
  // schedule view, where results render as the honest source of truth.

  let searchSeq = 0;
  const applySearchInput = debounce(async (raw) => {
    state.search = raw;
    if (raw.trim()) state.view = 'schedule';
    if (!raw.trim()) {
      state.searchResults = null;
      render();
      return;
    }
    const seq = ++searchSeq;
    let rows = [];
    try {
      const res = await window.centraid.read({ query: 'search', input: { term: raw } });
      rows = res?.events ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    render();
  }, 200);

  function clearSearch() {
    searchSeq += 1;
    state.search = '';
    state.searchResults = null;
    render();
  }

  return {
    notice,
    narrate,
    act,
    write,
    colorFor,
    findEvent,
    logActivity,
    clearPending,
    settlePending,
    reconcilePending,
    proposeEvent,
    rescheduleEvent,
    respondRsvp,
    cancelEvent,
    setAttachTarget,
    getAttachTarget,
    removeAttachment,
    applySearchInput,
    clearSearch,
  };
}
