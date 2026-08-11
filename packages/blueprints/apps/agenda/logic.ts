import { createPendingOverlayModel } from "../_shared/pending-overlay.ts";
import { colorForCalendar } from "./format.ts";
// Non-visual business logic: vault IO (write/act), calendar coloring, the
// session activity log, the pending-write overlay (issue #738), and search.
// `createLogic` closes over app.tsx's own `state`/`data` (mutated in place,
// never reassigned) plus the render/refresh entry points app.tsx defines —
// the same factory shape tasks/logic.ts and notes/logic.ts use.
import { debounce, outcomeMessage, statusLine } from "./kit.ts";
import { agendaPendingProjection } from "./pending-projection.ts";
import type {
  AgEvent,
  AppData,
  AppState,
  CreatePayload,
  EventEditPayload,
  OccurrenceEditPayload,
} from "./types.ts";

interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
  refresh: () => Promise<void> | void;
}

export function createLogic({ state, data, render, refresh }: LogicDeps) {
  // The shared pending-write overlay (issue #738): one model, created once,
  // that every write wraps through `act()` below. `state` holds no pending
  // fields of its own any more — `model.byRowId()` is the render-time source
  // for the accent-rail/pending-chip decoration app-root.tsx applies.
  const model = createPendingOverlayModel(agendaPendingProjection);

  function notice(text: string): void {
    const el = document.querySelector<HTMLElement>("#noticeBanner");
    if (!el) return;
    el.textContent = text;
    (el as HTMLElement).hidden = !text;
  }

  // Executed clears the banner and tells the caller to refresh; parked is
  // narrated by the caller (statusLine + the accent-rail/pending-chip treatment,
  // not the banner — this is a designed calm state, not an error);
  // failed/denied surface the plain-language reason in the banner.
  function narrate(outcome: VaultOutcome | undefined): boolean {
    if (outcome?.status === "executed") {
      notice("");
      return true;
    }
    if (outcome?.status === "parked") {
      notice("");
      return false;
    }
    const message = outcomeMessage(outcome);
    if (message) notice(message);
    return false;
  }

  function logActivity(
    eventId: string | null | undefined,
    text: string,
    outcome?: VaultOutcome
  ): void {
    if (!eventId) return;
    const list = state.activityLog.get(eventId) ?? [];
    list.unshift({
      text,
      when: "Today",
      receiptId: outcome?.receiptId ?? null,
    });
    state.activityLog.set(eventId, list.slice(0, 20));
  }

  /** Row id → pending state, for the accent-rail/pending-chip decoration
   *  (event ids for cancel/propose/edit, attendee ids for rsvp). */
  function pendingByRowId() {
    return model.byRowId();
  }

  /** The reload path (issue #738): rebuild overlay-status rows from the
   *  durable outbox alone — never from app memory. Feature-detected because
   *  the visual-harness mock and older hosts lack `pendingWrites()`. */
  async function restorePending(): Promise<void> {
    const durable = (await window.centraid.pendingWrites?.()) ?? [];
    model.restore(durable);
    render();
  }

  /** Fold one change-feed event into the pending model; true when it moved. */
  function applyPendingChange(detail: CentraidChangeDetail): boolean {
    return model.applyChangeDetail(detail);
  }

  function colorFor(calendarId: string | null | undefined): string | null {
    return colorForCalendar(
      calendarId ? data.calById.get(calendarId) : undefined,
      calendarId
    );
  }

  function findEvent(identity: string): AgEvent | null {
    return (
      (data.events ?? []).find(
        (event) =>
          (event.instance_key ?? event.event_id) === identity ||
          event.event_id === identity
      ) ?? null
    );
  }

  /**
   * Like write(), but returns the raw outcome for callers that narrate +
   * refresh themselves. Every write goes through here, so the pending
   * overlay (issue #738) tracks every write uniformly: mint the intent id,
   * project the app's declared optimistic mutations for it, and fold
   * whatever outcome comes back (or the transport failure) into the model.
   * An action absent from pending-projection.ts projects nothing — `begin()`
   * is then a no-op and this is exactly the old fire-and-forget `act()`.
   */
  async function act(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    const intentId = globalThis.crypto.randomUUID();
    const optimistic = model.begin(action, input, intentId);
    try {
      const outcome = await window.centraid.write({
        action,
        input,
        intentId,
        ...(optimistic.length > 0 ? { optimistic } : {}),
      });
      model.applyOutcome(outcome.invocationId ?? intentId, {
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.conflict === undefined
          ? {}
          : { conflict: outcome.conflict }),
      });
      return outcome;
    } catch (error) {
      // The write never reached (or never left) the vault — nothing is
      // durable, so the optimistic entry settles to `failed` rather than
      // hanging as `queued` forever (a dismissible/retryable row, same
      // grammar as a server-reported failure).
      model.applyOutcome(intentId, { status: "failed" });
      notice(String((error as { message?: string })?.message ?? error));
      return undefined;
    }
  }

  async function write(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act(action, input);
    const executed = narrate(outcome);
    if (executed || outcome?.status === "denied") await refresh();
    else render();
    return outcome;
  }

  // ---------- Event actions ----------

  async function proposeEvent(
    input: CreatePayload
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("propose", input);
    if (outcome?.status === "executed") {
      const newId = outcome.output?.event_id as string | undefined;
      logActivity(newId, `Proposed on ${input.calendar_id}`, outcome);
      statusLine("Event proposed · receipt", {
        undoLabel: newId ? "Undo" : undefined,
        onUndo: newId
          ? () => write("cancel-event", { event_id: newId })
          : undefined,
      });
    } else if (
      outcome?.status === "queued" ||
      outcome?.status === "in-flight"
    ) {
      statusLine(
        "Event saved on this device — it will sync when the gateway is reachable."
      );
    }
    return outcome;
  }

  async function editEvent(
    input: EventEditPayload
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("edit-event", input);
    if (outcome?.status === "executed") {
      logActivity(input.event_id, "Event details edited", outcome);
      statusLine("Event updated · receipt");
    } else if (
      outcome?.status === "queued" ||
      outcome?.status === "in-flight"
    ) {
      statusLine(
        "Event edit saved on this device — it will sync when connected."
      );
    }
    return outcome;
  }

  async function editOccurrence(
    input: OccurrenceEditPayload
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("edit-occurrence", input);
    if (outcome?.status === "executed") {
      logActivity(
        input.event_id,
        `${input.action === "skip" ? "Skipped" : "Edited"} ${input.scope}`,
        outcome
      );
      statusLine("Recurring event updated · receipt");
    } else if (
      outcome?.status === "queued" ||
      outcome?.status === "in-flight"
    ) {
      statusLine(
        "Recurrence edit saved on this device — it will sync when connected."
      );
    }
    return outcome;
  }

  async function respondRsvp(
    eventId: string,
    partyId: string,
    partstat: string
  ): Promise<VaultOutcome | undefined> {
    // `attendee_id` rides in `input` only so pending-projection.ts's `rsvp`
    // projection can key its optimistic upsert on the same row (the command
    // itself re-derives it server-side from event_id+party_id).
    const attendeeId = findEvent(eventId)?.attendees?.find(
      (item) => item.party_id === partyId
    )?.attendee_id;
    const outcome = await write("rsvp", {
      event_id: eventId,
      party_id: partyId,
      partstat,
      ...(attendeeId ? { attendee_id: attendeeId } : {}),
    });
    if (outcome?.status === "executed") {
      const label =
        partstat === "accepted"
          ? "Going"
          : partstat === "declined"
            ? "Not going"
            : "Maybe";
      logActivity(eventId, `RSVP: ${label}`, outcome);
      statusLine(`RSVP recorded: ${label} · receipt`);
    } else if (
      outcome?.status === "parked" ||
      outcome?.status === "queued" ||
      outcome?.status === "in-flight"
    ) {
      statusLine(
        outcome.status === "parked"
          ? "Sent to the owner for confirmation."
          : "RSVP saved on this device — it will sync when the gateway is reachable."
      );
      render();
    }
    return outcome;
  }

  async function cancelEvent(
    eventId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act("cancel-event", { event_id: eventId });
    const executed = narrate(outcome);
    if (
      outcome?.status === "parked" ||
      outcome?.status === "queued" ||
      outcome?.status === "in-flight"
    ) {
      logActivity(
        eventId,
        outcome.status === "parked"
          ? "Cancellation asked — parked for the owner"
          : "Cancellation saved offline",
        outcome
      );
      statusLine(
        outcome.status === "parked"
          ? "Sent to the owner for confirmation — it stays on the agenda until approved."
          : "Cancellation saved on this device — it will sync when the gateway is reachable.",
        { duration: 7000 }
      );
      render();
    } else if (executed) {
      logActivity(eventId, "Cancelled", outcome);
      statusLine("Event cancelled · receipt");
      await refresh();
    } else if (outcome?.status === "denied") {
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

  async function removeAttachment(
    attachmentId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act("detach", { attachment_id: attachmentId });
    if (narrate(outcome) || outcome?.status === "denied") await refresh();
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
    if (raw.trim()) state.view = "schedule";
    if (!raw.trim()) {
      state.searchResults = null;
      render();
      return;
    }
    const seq = ++searchSeq;
    let rows: AgEvent[] = [];
    try {
      const res = await window.centraid.read<{ events?: AgEvent[] }>({
        query: "search",
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
    state.search = "";
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
    pendingByRowId,
    restorePending,
    applyPendingChange,
    proposeEvent,
    editEvent,
    editOccurrence,
    respondRsvp,
    cancelEvent,
    setAttachTarget,
    getAttachTarget,
    removeAttachment,
    applySearchInput,
    clearSearch,
  };
}
