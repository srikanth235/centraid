// Non-visual business logic: vault IO (write/act), calendar coloring, the
// session activity log and parked-write tracking, and search. `createLogic`
// closes over app.tsx's own `state`/`data` (mutated in place, never
// reassigned) plus the render/refresh entry points app.tsx defines — the
// same factory shape tasks/logic.ts and notes/logic.ts use.
import { debounce, outcomeMessage, toast } from './kit.ts';
import { colorForCalendar } from './format.ts';
import {
  clearPendingState,
  reconcilePendingChange,
  settlePendingChange,
  trackPendingOutcome,
} from './pending.ts';
import type { AgEvent, AppData, AppState, CreatePayload } from './types.ts';

interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
  refresh: () => Promise<void> | void;
}

export function createLogic({ state, data, render, refresh }: LogicDeps) {
  function notice(text: string): void {
    const el = document.getElementById('noticeBanner');
    if (!el) return;
    el.textContent = text;
    (el as HTMLElement).hidden = !text;
  }

  // Executed clears the banner and tells the caller to refresh; parked is
  // narrated by the caller (toast + the accent-rail/pending-chip treatment,
  // not the banner — this is a designed calm state, not an error);
  // failed/denied surface the plain-language reason in the banner.
  function narrate(outcome: VaultOutcome | undefined): boolean {
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

  function logActivity(
    eventId: string | null | undefined,
    text: string,
    outcome?: VaultOutcome,
  ): void {
    if (!eventId) return;
    const list = state.activityLog.get(eventId) ?? [];
    list.unshift({ text, when: 'Today', receiptId: outcome?.receiptId ?? null });
    state.activityLog.set(eventId, list.slice(0, 20));
  }

  function clearPending(): void {
    clearPendingState(state);
  }

  function trackPending(
    eventId: string | null | undefined,
    kind: string,
    outcome: VaultOutcome | undefined,
  ): boolean {
    return trackPendingOutcome(state, eventId, kind, outcome);
  }

  function settlePending(detail: CentraidChangeDetail): boolean {
    return settlePendingChange(state, detail);
  }

  function reconcilePending(detail: CentraidChangeDetail, managed: boolean): boolean {
    return reconcilePendingChange(state, detail, managed);
  }

  function colorFor(calendarId: string | null | undefined): string | null {
    return colorForCalendar(calendarId ? data.calById.get(calendarId) : undefined, calendarId);
  }

  function findEvent(eventId: string): AgEvent | null {
    return (data.events ?? []).find((e) => e.event_id === eventId) ?? null;
  }

  /** Like write(), but returns the raw outcome for callers that narrate + refresh themselves. */
  async function act(
    action: string,
    input: Record<string, unknown>,
    optimistic?: unknown,
  ): Promise<VaultOutcome | undefined> {
    try {
      // The change-bridge accepts an `optimistic` overlay-ops array that the
      // ambient CentraidClient.write type (types/centraid.d.ts, out of scope
      // here) does not list; spread it so the excess property rides through.
      return await window.centraid.write({
        action,
        input,
        ...(optimistic !== undefined ? { optimistic } : {}),
      });
    } catch (err) {
      notice(String((err as { message?: string })?.message ?? err));
      return undefined;
    }
  }

  async function write(
    action: string,
    input: Record<string, unknown>,
    optimistic?: unknown,
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act(action, input, optimistic);
    const executed = narrate(outcome);
    if (executed || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // ---------- Event actions ----------

  async function proposeEvent(input: CreatePayload): Promise<VaultOutcome | undefined> {
    const outcome = await write('propose', input);
    if (outcome?.status === 'executed') {
      const newId = outcome.output?.event_id as string | undefined;
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

  async function rescheduleEvent(
    eventId: string,
    dtstart: string,
    dtend: string,
  ): Promise<VaultOutcome | undefined> {
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

  async function respondRsvp(
    eventId: string,
    partyId: string,
    partstat: string,
  ): Promise<VaultOutcome | undefined> {
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

  async function cancelEvent(eventId: string): Promise<VaultOutcome | undefined> {
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

  // ---------- Attachments (kit.ts renderAttachments / wireAttachInput) ----------

  let attachTarget: string | null = null;
  const setAttachTarget = (eventId: string) => {
    attachTarget = eventId;
  };
  const getAttachTarget = () => attachTarget;

  async function removeAttachment(attachmentId: string): Promise<VaultOutcome | undefined> {
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
  const applySearchInput = debounce(async (raw: string) => {
    state.search = raw;
    if (raw.trim()) state.view = 'schedule';
    if (!raw.trim()) {
      state.searchResults = null;
      render();
      return;
    }
    const seq = ++searchSeq;
    let rows: AgEvent[] = [];
    try {
      const res = await window.centraid.read<{ events?: AgEvent[] }>({
        query: 'search',
        input: { term: raw },
      });
      rows = res?.events ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    render();
  }, 200);

  function clearSearch(): void {
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
