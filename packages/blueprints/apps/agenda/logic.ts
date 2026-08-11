import { createPendingOverlayModel } from "../_shared/pending-overlay.ts";
import type { PendingRowState } from "../_shared/pending-overlay.ts";
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
  // Discarding (or taking for a retry/edit) an attention row also clears its
  // DURABLE record through the engine's one port — a row that returns on the
  // next reload was never really discarded. The clear is fire-and-forget by
  // contract, so the failure is narrated here rather than swallowed.
  const model = createPendingOverlayModel(agendaPendingProjection, {
    dismissDurable: (intentId) => {
      const forget = window.centraid.dismissAttentionWrite;
      if (!forget) return;
      void forget({ intentId }).catch(() =>
        notice("That change is gone from this view but may return on reload.")
      );
    },
  });

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

  /** The reload path (issue #738): rebuild from local truth alone — never
   *  from app memory. TWO durable sources, because a settled write leaves the
   *  outbox: the outbox for what is still in flight, the attention journal
   *  for what came back denied/conflicted/failed. Feature-detected because
   *  the visual-harness mock and older hosts lack both.
   *
   *  `window.centraid` itself is optional here, not defensively: a remount
   *  tears the inline bridge down before the next one installs, so a refresh
   *  already in flight can legitimately outlive the client it started on. */
  async function restorePending(): Promise<void> {
    const [durable, attention] = await Promise.all([
      window.centraid?.pendingWrites?.(),
      window.centraid?.attentionWrites?.(),
    ]);
    // An absent answer is NOT an empty outbox. `restore` prunes rows the
    // durable list omits, so folding "no host surface" or "bridge torn down"
    // into `[]` would delete every queued row — the wipe class #738 exists
    // to end, merely moved from the commons rail to the outbox rail.
    if (durable) model.restore(durable);
    if (attention) model.restoreAttention(attention);
    render();
  }

  /** The writes that settled without executing and still need an answer —
   *  the panel `components/Attention.tsx` renders above the canvas. */
  function attentionRows(): PendingRowState[] {
    return model.attention();
  }

  /** Discard one — here and in the durable journal (the model's port). */
  function dismissPending(intentId: string): boolean {
    const dismissed = model.dismiss(intentId);
    if (dismissed) render();
    return dismissed;
  }

  /** Re-issue a refused write under a FRESH intent id: the old id's payload
   *  hash is bound to the attempt that failed, so replaying it would dedupe
   *  onto that failure instead of trying again. Whatever the resend settles
   *  as lands back on its own row, so this never narrates twice. */
  async function retryPending(
    intentId: string
  ): Promise<VaultOutcome | undefined> {
    const retry = model.takeForRetry(intentId);
    if (!retry) return undefined;
    render();
    const outcome = await act(retry.action, retry.input);
    render();
    return outcome;
  }

  /**
   * The third answer beside retry and discard: reopen the COMPOSER on the
   * refused payload so it can be corrected before it is resent. Only
   * `propose` has one — the create modal — and only for a record whose input
   * survived the settle; every other action's edit surface (the event drawer)
   * edits the canonical event, not this payload, so offering "Edit" there
   * would open something that is not what the member refused.
   */
  function editPending(intentId: string): boolean {
    const entry = model.rows().find((row) => row.intentId === intentId);
    if (!entry || !isEditablePending(entry)) return false;
    const taken = model.takeForRetry(intentId);
    if (!taken) return false;
    const raw = taken.input;
    const text = (key: string): string | undefined =>
      typeof raw[key] === "string" && raw[key]
        ? (raw[key] as string)
        : undefined;
    const start = new Date(String(raw.dtstart ?? ""));
    const end = new Date(String(raw.dtend ?? ""));
    state.createPrefill = {
      ...(Number.isNaN(start.getTime()) ? {} : { start }),
      ...(Number.isNaN(end.getTime()) ? {} : { end }),
      ...(text("summary") ? { summary: text("summary")! } : {}),
      ...(text("description") ? { description: text("description")! } : {}),
      ...(text("calendar_id") ? { calendarId: text("calendar_id")! } : {}),
      ...(text("rrule") ? { rrule: text("rrule")! } : {}),
    };
    state.createOpen = true;
    render();
    return true;
  }

  /** A refused write the create composer can honestly reopen. */
  function isEditablePending(row: PendingRowState): boolean {
    return row.action === "propose" && row.input !== undefined;
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
  /**
   * The optimistic-concurrency precondition for one write (issue #738 P2):
   * the version of the row this device composed the change against, read
   * from the local replica. Without it a conflict cannot even occur — the
   * vault has nothing to compare — so this is what makes a `conflict`
   * outcome, and its expected-vs-actual row, reachable at all.
   *
   * The row is whichever one the write actually edits, which is the same row
   * `pending-projection.ts` keys its overlay on: an RSVP edits the attendee's
   * OWN `schedule.attendee` row, everything else edits `core.event`. A
   * `propose` creates and so has nothing to be stale against; an
   * `edit-occurrence` outside `scope: "series"` writes a recurrence exception
   * rather than the event, so it carries no precondition either.
   */
  async function baseVersionsFor(
    action: string,
    input: Record<string, unknown>
  ): Promise<CentraidBaseVersion[]> {
    let target: { entity: string; rowId: unknown } | undefined;
    if (action === "rsvp")
      target = { entity: "schedule.attendee", rowId: input.attendee_id };
    else if (action === "edit-event" || action === "cancel-event")
      target = { entity: "core.event", rowId: input.event_id };
    else if (action === "edit-occurrence" && input.scope === "series")
      target = { entity: "core.event", rowId: input.event_id };
    if (!target || typeof target.rowId !== "string" || !target.rowId) return [];
    const readVersion = window.centraid.rowVersion;
    if (!readVersion) return [];
    const rowId = target.rowId;
    const version = await readVersion({ entity: target.entity, rowId });
    return version === undefined
      ? []
      : [{ entity: target.entity, rowId, version }];
  }

  async function act(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    const intentId = globalThis.crypto.randomUUID();
    const optimistic = model.begin(action, input, intentId);
    try {
      const baseVersions = await baseVersionsFor(action, input);
      const outcome = await window.centraid.write({
        action,
        input,
        intentId,
        ...(optimistic.length > 0 ? { optimistic } : {}),
        ...(baseVersions.length > 0 ? { baseVersions } : {}),
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
    attentionRows,
    dismissPending,
    retryPending,
    editPending,
    isEditablePending,
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
