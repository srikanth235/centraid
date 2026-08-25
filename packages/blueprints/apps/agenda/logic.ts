// Agenda's vault IO: the typed commands, the search read, and the narration
// each outcome earns. `createLogic` closes over the orchestrator's own
// `state`/`data` bags (mutated in place, never reassigned) plus the render and
// refresh entry points it defines — the same factory shape docs/logic.ts uses.
//
// THREE OUTCOMES, THREE DIFFERENT SENTENCES, none of them an error:
//
//   * `executed` — the vault applied it; the status line carries the receipt.
//   * `parked`   — the vault is HOLDING the ask for the owner. This is the
//                  designed `parked cancel` state, not a failure. There is no
//                  unpark door in an app's hands: the owner approves or denies
//                  in Approvals (`window.centraid.openApprovals`), and the
//                  event stays on the agenda meanwhile.
//   * `queued` / `in-flight` — the write is on this device and will go when
//                  the gateway answers. The row already shows it.

import { debounce, outcomeMessage } from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import type { InlineFrame } from "../inline-types.ts";
import { projectRsvpInto } from "./edits.ts";
import type { RsvpAnswer } from "./edits.ts";
import type {
  AgEvent,
  AppData,
  AppState,
  CreatePayload,
  EventEditPayload,
  OccurrenceEditPayload,
} from "./types.ts";
import {
  OUTCOME_DETACHED,
  OUTCOME_OCCURRENCE,
  OUTCOME_PARKED,
  OUTCOME_PROPOSED,
  OUTCOME_QUEUED,
  OUTCOME_UPDATED,
  RSVP_OUTCOME,
} from "./view-copy.ts";

interface LogicDeps {
  state: AppState;
  data: AppData;
  frame: InlineFrame;
  render: () => void;
  refresh: () => Promise<void> | void;
}

/** Statuses that mean "the member's device is holding this write". */
function isHeld(status: string | undefined): boolean {
  return status === "queued" || status === "in-flight" || status === "sending";
}

export function createLogic({
  state,
  data,
  frame,
  render,
  refresh,
}: LogicDeps) {
  /** The in-pane notice, driven imperatively so React never clobbers it. */
  function notice(text: string): void {
    const el = document.querySelector<HTMLElement>("#noticeBanner");
    if (!el) return;
    el.textContent = text;
    el.hidden = text === "";
  }

  /**
   * Executed clears the notice and tells the caller to refresh; parked is
   * narrated by the caller (it is a calm designed state, not a banner);
   * everything else puts the plain-language reason in the notice.
   */
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

  /** One write, returning the raw outcome for callers that narrate their own. */
  async function act(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    try {
      return await window.centraid.write({ action, input });
    } catch (error) {
      notice(String((error as { message?: string })?.message ?? error));
      return undefined;
    }
  }

  async function write(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act(action, input);
    narrate(outcome);
    if (outcome) await refresh();
    else render();
    return outcome;
  }

  /** The one place a held or parked write is put into words. */
  function narrateHeld(outcome: VaultOutcome | undefined): boolean {
    if (outcome?.status === "parked") {
      publishOutcome(frame, { text: OUTCOME_PARKED });
      return true;
    }
    if (isHeld(outcome?.status)) {
      publishOutcome(frame, { text: OUTCOME_QUEUED });
      return true;
    }
    return false;
  }

  // ────────── Event commands ──────────

  async function proposeEvent(
    input: CreatePayload
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("propose", input);
    if (outcome?.status === "executed") {
      const newId = outcome.output?.event_id as string | undefined;
      publishOutcome(frame, {
        text: OUTCOME_PROPOSED,
        ...(newId ? { undo: () => void cancelEvent(newId) } : {}),
      });
    } else narrateHeld(outcome);
    return outcome;
  }

  async function editEvent(
    input: EventEditPayload
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("edit-event", input);
    if (outcome?.status === "executed")
      publishOutcome(frame, { text: OUTCOME_UPDATED });
    else narrateHeld(outcome);
    return outcome;
  }

  async function editOccurrence(
    input: OccurrenceEditPayload
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("edit-occurrence", input);
    if (outcome?.status === "executed")
      publishOutcome(frame, { text: OUTCOME_OCCURRENCE });
    else narrateHeld(outcome);
    return outcome;
  }

  /**
   * RSVP, projected back into the guest list before the vault answers.
   *
   * The projection is applied to the loaded window in place so every view
   * showing that event shows the answer on the same frame — a member who
   * presses Going and watches the row stay "No answer yet" for a round trip
   * has been told the press did nothing.
   */
  async function respondRsvp(
    eventId: string,
    partyId: string,
    partstat: RsvpAnswer
  ): Promise<VaultOutcome | undefined> {
    data.events = projectRsvpInto(data.events, eventId, partyId, partstat);
    data.miniEvents = projectRsvpInto(
      data.miniEvents,
      eventId,
      partyId,
      partstat
    );
    if (state.searchResults)
      state.searchResults = projectRsvpInto(
        state.searchResults,
        eventId,
        partyId,
        partstat
      );
    render();
    const outcome = await write("rsvp", {
      event_id: eventId,
      party_id: partyId,
      partstat,
    });
    if (outcome?.status === "executed") {
      const text = RSVP_OUTCOME[partstat];
      if (text) publishOutcome(frame, { text });
    } else narrateHeld(outcome);
    return outcome;
  }

  /**
   * Ask to cancel. CANCELLING PARKS: the vault treats it as medium-risk and
   * holds it for the owner rather than executing, so `parked` is the ordinary
   * outcome here and not the exception. The event stays on the agenda, the row
   * carries the held-write mark, and the detail panel says what is held and
   * who releases it.
   */
  async function cancelEvent(
    eventId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act("cancel-event", { event_id: eventId });
    // A HELD ASK IS NOT A FAILURE, so it is answered before `narrate` gets a
    // chance to put a reason in the notice banner: the row already carries the
    // mark and the status line already carries the sentence.
    if (narrateHeld(outcome)) {
      render();
      return outcome;
    }
    const executed = narrate(outcome);
    if (executed || outcome?.status === "denied") await refresh();
    else render();
    return outcome;
  }

  // ────────── Attachments ──────────

  let attachTarget: string | null = null;
  const setAttachTarget = (eventId: string): void => {
    attachTarget = eventId;
  };
  const getAttachTarget = (): string | null => attachTarget;

  async function removeAttachment(
    attachmentId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("detach", { attachment_id: attachmentId });
    if (outcome?.status === "executed")
      publishOutcome(frame, { text: OUTCOME_DETACHED });
    else narrateHeld(outcome);
    return outcome;
  }

  // ────────── Search ──────────
  // Searching asks the VAULT, not the loaded window: the FTS5 index matches
  // over every event, so the app never greps an unbounded table in memory.

  let searchSeq = 0;
  const applySearchInput = debounce(async (raw: string) => {
    state.search = raw;
    if (!raw.trim()) {
      state.searchResults = null;
      render();
      return;
    }
    const seq = ++searchSeq;
    let rows: AgEvent[] | null = [];
    try {
      const result = await window.centraid.read<{ events?: AgEvent[] }>({
        query: "search",
        input: { term: raw },
      });
      rows = result?.events ?? [];
    } catch {
      // A THROW IS NOT AN EMPTY RESULT SET — the index lives on the gateway,
      // and "nothing matches" would be a claim nobody verified.
      rows = null;
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
    act,
    applySearchInput,
    cancelEvent,
    clearSearch,
    editEvent,
    editOccurrence,
    getAttachTarget,
    narrate,
    notice,
    proposeEvent,
    removeAttachment,
    respondRsvp,
    setAttachTarget,
    write,
  };
}
