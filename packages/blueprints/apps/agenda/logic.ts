// Agenda vault IO. `parked` is a designed hold (no unpark door in an app),
// not an error; `queued`/`in-flight` stay on this device until the gateway answers.

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

  /** Project RSVP into the loaded window before the vault answers. */
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

  /** Cancelling parks — `parked` is the ordinary outcome. */
  async function cancelEvent(
    eventId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act("cancel-event", { event_id: eventId });
    // A held ask is not a failure — answer it before `narrate` writes a reason.
    if (narrateHeld(outcome)) {
      render();
      return outcome;
    }
    const executed = narrate(outcome);
    if (executed || outcome?.status === "denied") await refresh();
    else render();
    return outcome;
  }

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

  // Search asks the vault FTS5 index, not the loaded window.
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
      // A throw is not an empty result set — "nothing matches" would be unverified.
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
