// People's WRITE side: every command this app dispatches, and what the frame's
// one status line says afterwards.
//
// THREE RULES HOLD HERE, AND NOTHING ELSE DOES.
//
// 1. ONE DOOR. Every write is `window.centraid.write({action, input, intentId})`
//    and every outcome is narrated through `publishOutcome` on the frame's
//    single status line. No toast, no second line, no badge.
//
// 2. AN OUTCOME IS NOT A THROW. The action surface answers HTTP 200 with a
//    denied/parked/queued body; only a transport failure rejects. So `executed`
//    is checked, never assumed, and the four other terminal states each keep
//    their own sentence — a queued write and a write awaiting approval are
//    different facts about the member's data.
//
// 3. UNDO IS OFFERED ONLY WHERE A TRUE REVERSE WRITE EXISTS: star↔unstar,
//    trash→restore, edit-person back to its previous values, set-cadence back
//    to its previous number. Everything else reports what happened and stops.
//    An `Undo` that would have to invent a compensating write — un-adding a
//    note, un-logging a touch — is a button that lies about what the vault can
//    do, and the vault is the thing this product is for.
import { publishOutcome } from "../_shared/app-frame.tsx";
import type { InlineFrame } from "../inline-types.ts";
import { OUTCOMES, REFUSALS } from "./people-copy.ts";
import type {
  ContactChannel,
  LogDraft,
  PersonDetail,
  PersonDraft,
  PersonRow,
  TrashedPerson,
} from "./types.ts";

interface WriteDeps {
  frame: InlineFrame;
  refresh: () => Promise<void>;
  /** The status line is carrying an OUTCOME now, so the ambient sentence must
   *  not overwrite it on the next render. Cleared by the next navigation. */
  hold: () => void;
  notice: (text?: string) => void;
}

/** What a non-executed outcome says. Each status keeps its own sentence. */
function refusal(outcome: VaultOutcome | undefined): string {
  if (outcome?.status === "parked") return REFUSALS.parked;
  if (outcome?.status === "queued" || outcome?.status === "in-flight")
    return REFUSALS.queued;
  if (outcome?.status === "denied") return REFUSALS.denied;
  return REFUSALS.failed;
}

export function createWrites({ frame, refresh, hold, notice }: WriteDeps) {
  /** One command. The intent id is minted here so a pending write can be
   *  recognised in the outbox as this app's own (`pending-projection.ts`). */
  async function act(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    try {
      return await window.centraid.write({
        action,
        input,
        intentId: globalThis.crypto.randomUUID(),
      });
    } catch (error) {
      notice(String((error as { message?: string })?.message ?? error));
      return undefined;
    }
  }

  /** Report an outcome and refresh. Returns whether the write landed, so a
   *  caller can decide what to do next rather than guessing from a void. */
  async function settle(
    outcome: VaultOutcome | undefined,
    text: string,
    undo?: () => void
  ): Promise<boolean> {
    hold();
    if (outcome?.status !== "executed") {
      publishOutcome(frame, { text: refusal(outcome) });
      return false;
    }
    notice("");
    publishOutcome(frame, { text, ...(undo ? { undo } : {}) });
    await refresh();
    return true;
  }

  // ---------- The star ----------

  /** Star and unstar are each other's reverse, so this is the clearest Undo in
   *  the app: the same pair of commands, run the other way round. */
  async function toggleStar(person: {
    party_id: string;
    name: string;
    starred: boolean;
  }): Promise<void> {
    const starring = !person.starred;
    const outcome = await act(starring ? "star-person" : "unstar-person", {
      party_id: person.party_id,
    });
    const text = starring
      ? OUTCOMES.starred(person.name)
      : OUTCOMES.unstarred(person.name);
    await settle(outcome, text, () => {
      void (async () => {
        const back = await act(starring ? "unstar-person" : "star-person", {
          party_id: person.party_id,
        });
        await settle(
          back,
          starring
            ? OUTCOMES.unstarred(person.name)
            : OUTCOMES.starred(person.name)
        );
      })();
    });
  }

  // ---------- Trash and restore ----------

  async function trashPerson(person: {
    party_id: string;
    name: string;
  }): Promise<void> {
    const outcome = await act("trash-person", { party_id: person.party_id });
    await settle(outcome, OUTCOMES.trashed(person.name), () => {
      void (async () => {
        const back = await act("restore-person", {
          party_id: person.party_id,
        });
        await settle(back, OUTCOMES.restored(person.name));
      })();
    });
  }

  async function restorePerson(person: TrashedPerson): Promise<void> {
    const outcome = await act("restore-person", { party_id: person.party_id });
    await settle(outcome, OUTCOMES.restored(person.name));
  }

  // ---------- The person record ----------

  /**
   * Save the edit/new form.
   *
   * A NEW PERSON IS ONE COMMAND; an edit is up to two, because the vault keeps
   * the cadence on its own command (`set-cadence`) — the same number reached
   * two ways would be two places to change it. The undo restores the previous
   * values through the same pair, which is why `previous` is asked for rather
   * than read back afterwards: after the write, the previous values are gone.
   */
  async function savePerson(
    draft: PersonDraft,
    previous: PersonDetail | null
  ): Promise<void> {
    if (!draft.party_id) {
      const outcome = await act("add-person", {
        display_name: draft.name,
        cadence_days: draft.cadence_days,
        ...(draft.role ? { role: draft.role } : {}),
        ...(draft.avatar_color ? { avatar_color: draft.avatar_color } : {}),
      });
      await settle(outcome, OUTCOMES.added(draft.name));
      return;
    }
    const partyId = draft.party_id;
    const outcome = await act("edit-person", {
      party_id: partyId,
      display_name: draft.name,
      role: draft.role,
      ...(draft.avatar_color ? { avatar_color: draft.avatar_color } : {}),
    });
    if (outcome?.status === "executed" && previous) {
      if (previous.cadence_days !== draft.cadence_days) {
        await act("set-cadence", {
          party_id: partyId,
          cadence_days: draft.cadence_days,
        });
      }
    }
    await settle(outcome, OUTCOMES.edited(draft.name), () => {
      if (!previous) return;
      void (async () => {
        const back = await act("edit-person", {
          party_id: partyId,
          display_name: previous.name,
          role: previous.role,
          ...(previous.avatar_color
            ? { avatar_color: previous.avatar_color }
            : {}),
        });
        if (previous.cadence_days !== draft.cadence_days) {
          await act("set-cadence", {
            party_id: partyId,
            cadence_days: previous.cadence_days,
          });
        }
        await settle(back, OUTCOMES.edited(previous.name));
      })();
    });
  }

  /** The cadence on its own — the person screen's chip row, where the form is
   *  not open. Its reverse is the previous number, which the caller holds. */
  async function setCadence(
    person: { party_id: string; name: string; cadence_days: number },
    cadenceDays: number
  ): Promise<void> {
    const previous = person.cadence_days;
    const outcome = await act("set-cadence", {
      party_id: person.party_id,
      cadence_days: cadenceDays,
    });
    await settle(outcome, OUTCOMES.cadence(person.name), () => {
      void (async () => {
        const back = await act("set-cadence", {
          party_id: person.party_id,
          cadence_days: previous,
        });
        await settle(back, OUTCOMES.cadence(person.name));
      })();
    });
  }

  // ---------- The most repeated act in the app ----------

  /** Logging stamps last-contacted to zero and prepends the touch to Recent.
   *  No Undo: nothing in the contract un-logs an interaction, and a button
   *  that silently logged a second one would be worse than none. */
  async function logTouch(draft: LogDraft, name: string): Promise<void> {
    const outcome = await act("log-interaction", {
      party_id: draft.party_id,
      kind: draft.kind,
      ...(draft.text ? { text: draft.text } : {}),
    });
    await settle(outcome, OUTCOMES.logged(draft.kind, name));
  }

  // ---------- The person screen's sections ----------

  async function addNote(
    partyId: string,
    text: string,
    name: string
  ): Promise<void> {
    const outcome = await act("add-note", { party_id: partyId, text });
    await settle(outcome, OUTCOMES.noted(name));
  }

  async function addImportantDate(
    partyId: string,
    label: string,
    monthDay: string,
    name: string
  ): Promise<void> {
    const outcome = await act("add-important-date", {
      party_id: partyId,
      label,
      month_day: monthDay,
      reminder_on: true,
    });
    await settle(outcome, OUTCOMES.dated(name));
  }

  /** The per-date reminder toggle. The command flips whatever it finds, so the
   *  caller says which way it went for the sentence — and no Undo is offered,
   *  because a second toggle is a new decision rather than a reversal of the
   *  first one. */
  async function toggleReminder(
    dateId: string,
    label: string,
    on: boolean
  ): Promise<void> {
    const outcome = await act("toggle-reminder", { date_id: dateId });
    await settle(
      outcome,
      on ? OUTCOMES.reminderOff(label) : OUTCOMES.reminderOn(label)
    );
  }

  async function saveChannel(
    partyId: string,
    channel: {
      kind: ContactChannel["kind"];
      value: string;
      label?: string;
      channel_id?: string;
      preferred?: boolean;
    }
  ): Promise<void> {
    const outcome = await act("save-contact-channel", {
      party_id: partyId,
      kind: channel.kind,
      value: channel.value,
      ...(channel.channel_id ? { channel_id: channel.channel_id } : {}),
      ...(channel.label ? { label: channel.label } : {}),
      ...(channel.preferred === undefined
        ? {}
        : { preferred: channel.preferred }),
    });
    await settle(outcome, OUTCOMES.channelSaved(channel.kind));
  }

  async function deleteChannel(channel: ContactChannel): Promise<void> {
    if (!channel.channel_id) return;
    const outcome = await act("delete-contact-channel", {
      channel_id: channel.channel_id,
    });
    await settle(outcome, OUTCOMES.channelRemoved(channel.kind));
  }

  // ---------- Merge ----------

  /** The one act with no reverse at all, which is why it is behind a modal
   *  confirm rather than behind an Undo. */
  async function mergePeople(
    source: PersonRow,
    target: { party_id: string; name: string }
  ): Promise<boolean> {
    const outcome = await act("merge-people", {
      source_party_id: source.party_id,
      target_party_id: target.party_id,
    });
    return settle(outcome, OUTCOMES.merged(source.name, target.name));
  }

  return {
    act,
    toggleStar,
    trashPerson,
    restorePerson,
    savePerson,
    setCadence,
    logTouch,
    addNote,
    addImportantDate,
    toggleReminder,
    saveChannel,
    deleteChannel,
    mergePeople,
  };
}
