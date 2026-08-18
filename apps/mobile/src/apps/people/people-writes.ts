// People's WRITE side on the phone — the web `writes.ts` doctrine over the
// native session.
//
// THREE RULES HOLD HERE, AND NOTHING ELSE DOES (the web module states them):
//
// 1. ONE DOOR. Every write is `session.write("people", {action, input})`, and
//    every outcome lands on the frame's one status line (`postStatus`) —
//    no toast, no badge, no second line. Parked writes route to Approvals;
//    queued writes say so in People's own sentence.
// 2. AN OUTCOME IS NOT A THROW. `surfaceWriteOutcome` narrates parked, queued
//    and denied; only a transport failure reaches `surfaceWriteFailure`.
// 3. UNDO IS OFFERED ONLY WHERE A TRUE REVERSE WRITE EXISTS: star↔unstar,
//    trash→restore, edit-person back, set-cadence back. Everything else
//    reports what happened and stops — an `Undo` that would have to invent a
//    compensating write is a button that lies about what the vault can do.

import { useCallback, useMemo } from "react";

import { OUTCOMES, VERBS } from "@centraid/blueprints/apps/people/people-copy";
import type {
  ContactChannel,
  LogDraft,
  PersonDraft,
} from "@centraid/blueprints/apps/people/types";

import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";

type Input = Record<string, string | number | boolean>;

export interface PeopleWrites {
  toggleStar: (person: {
    party_id: string;
    name: string;
    starred: boolean;
  }) => Promise<void>;
  trashPerson: (person: { party_id: string; name: string }) => Promise<boolean>;
  restorePerson: (person: { party_id: string; name: string }) => Promise<void>;
  savePerson: (
    draft: PersonDraft,
    previous: {
      name: string;
      role: string;
      avatar_color: string | null;
      cadence_days: number;
    } | null
  ) => Promise<boolean>;
  logTouch: (draft: LogDraft, name: string) => Promise<boolean>;
  addNote: (partyId: string, text: string, name: string) => Promise<boolean>;
  addImportantDate: (
    partyId: string,
    label: string,
    monthDay: string,
    name: string
  ) => Promise<boolean>;
  toggleReminder: (dateId: string, label: string, on: boolean) => Promise<void>;
  saveChannel: (
    partyId: string,
    channel: { kind: ContactChannel["kind"]; value: string; label?: string }
  ) => Promise<boolean>;
  deleteChannel: (channel: ContactChannel) => Promise<void>;
  mergePeople: (
    source: { party_id: string; name: string },
    target: { party_id: string; name: string }
  ) => Promise<boolean>;
}

export function usePeopleWrites(
  /** Where a PARKED write sends the member: the frame's Approvals screen —
   *  the caller navigates, this module only says when. */
  onParked: () => void
): PeopleWrites {
  const { session } = useReplica();

  /** One command. Returns whether the write may be treated as landed — the
   *  optimistic contract `surfaceWriteOutcome` narrates. */
  const act = useCallback(
    async (action: string, input: Input): Promise<boolean> => {
      if (!session) return false;
      try {
        const result = await session.write("people", { action, input });
        return surfaceWriteOutcome(result, {
          onParked,
          queuedMessage: "This People change will sync automatically.",
        });
      } catch (error) {
        surfaceWriteFailure(error, "People change failed");
        return false;
      }
    },
    [onParked, session]
  );

  /** Report a landed write, with `Undo` beside it exactly where the caller
   *  holds a true reverse write. */
  const report = useCallback((text: string, undo?: () => Promise<void>) => {
    postStatus(
      text,
      undo
        ? {
            action: {
              label: VERBS.undo,
              run: () => {
                void undo();
              },
            },
          }
        : undefined
    );
  }, []);

  return useMemo<PeopleWrites>(() => {
    const toggleStar: PeopleWrites["toggleStar"] = async (person) => {
      const starring = !person.starred;
      const landed = await act(starring ? "star-person" : "unstar-person", {
        party_id: person.party_id,
      });
      if (!landed) return;
      report(
        starring
          ? OUTCOMES.starred(person.name)
          : OUTCOMES.unstarred(person.name),
        async () => {
          const back = await act(starring ? "unstar-person" : "star-person", {
            party_id: person.party_id,
          });
          if (back)
            report(
              starring
                ? OUTCOMES.unstarred(person.name)
                : OUTCOMES.starred(person.name)
            );
        }
      );
    };

    const trashPerson: PeopleWrites["trashPerson"] = async (person) => {
      const landed = await act("trash-person", { party_id: person.party_id });
      if (!landed) return false;
      report(OUTCOMES.trashed(person.name), async () => {
        const back = await act("restore-person", {
          party_id: person.party_id,
        });
        if (back) report(OUTCOMES.restored(person.name));
      });
      return true;
    };

    const restorePerson: PeopleWrites["restorePerson"] = async (person) => {
      const landed = await act("restore-person", {
        party_id: person.party_id,
      });
      if (landed) report(OUTCOMES.restored(person.name));
    };

    const savePerson: PeopleWrites["savePerson"] = async (draft, previous) => {
      if (!draft.party_id) {
        const landed = await act("add-person", {
          display_name: draft.name,
          cadence_days: draft.cadence_days,
          ...(draft.role ? { role: draft.role } : {}),
          ...(draft.avatar_color ? { avatar_color: draft.avatar_color } : {}),
        });
        if (landed) report(OUTCOMES.added(draft.name));
        return landed;
      }
      const partyId = draft.party_id;
      const landed = await act("edit-person", {
        party_id: partyId,
        display_name: draft.name,
        role: draft.role,
        ...(draft.avatar_color ? { avatar_color: draft.avatar_color } : {}),
      });
      if (!landed) return false;
      if (previous && previous.cadence_days !== draft.cadence_days) {
        await act("set-cadence", {
          party_id: partyId,
          cadence_days: draft.cadence_days,
        });
      }
      report(
        OUTCOMES.edited(draft.name),
        previous
          ? async () => {
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
              if (back) report(OUTCOMES.edited(previous.name));
            }
          : undefined
      );
      return true;
    };

    /** No Undo: nothing in the contract un-logs an interaction. */
    const logTouch: PeopleWrites["logTouch"] = async (draft, name) => {
      const landed = await act("log-interaction", {
        party_id: draft.party_id,
        kind: draft.kind,
        ...(draft.text ? { text: draft.text } : {}),
      });
      if (landed) report(OUTCOMES.logged(draft.kind, name));
      return landed;
    };

    const addNote: PeopleWrites["addNote"] = async (partyId, text, name) => {
      const landed = await act("add-note", { party_id: partyId, text });
      if (landed) report(OUTCOMES.noted(name));
      return landed;
    };

    const addImportantDate: PeopleWrites["addImportantDate"] = async (
      partyId,
      label,
      monthDay,
      name
    ) => {
      const landed = await act("add-important-date", {
        party_id: partyId,
        label,
        month_day: monthDay,
        reminder_on: true,
      });
      if (landed) report(OUTCOMES.dated(name));
      return landed;
    };

    /** The command flips whatever it finds; the caller says which way it went
     *  for the sentence. No Undo — a second toggle is a new decision. */
    const toggleReminder: PeopleWrites["toggleReminder"] = async (
      dateId,
      label,
      on
    ) => {
      const landed = await act("toggle-reminder", { date_id: dateId });
      if (landed)
        report(on ? OUTCOMES.reminderOff(label) : OUTCOMES.reminderOn(label));
    };

    const saveChannel: PeopleWrites["saveChannel"] = async (
      partyId,
      channel
    ) => {
      const landed = await act("save-contact-channel", {
        party_id: partyId,
        kind: channel.kind,
        value: channel.value,
        ...(channel.label ? { label: channel.label } : {}),
      });
      if (landed) report(OUTCOMES.channelSaved(channel.kind));
      return landed;
    };

    const deleteChannel: PeopleWrites["deleteChannel"] = async (channel) => {
      if (!channel.channel_id) return;
      const landed = await act("delete-contact-channel", {
        channel_id: channel.channel_id,
      });
      if (landed) report(OUTCOMES.channelRemoved(channel.kind));
    };

    /** The one act with no reverse at all — behind the modal confirm, never
     *  behind an Undo. */
    const mergePeople: PeopleWrites["mergePeople"] = async (source, target) => {
      const landed = await act("merge-people", {
        source_party_id: source.party_id,
        target_party_id: target.party_id,
      });
      if (landed) report(OUTCOMES.merged(source.name, target.name));
      return landed;
    };

    return {
      toggleStar,
      trashPerson,
      restorePerson,
      savePerson,
      logTouch,
      addNote,
      addImportantDate,
      toggleReminder,
      saveChannel,
      deleteChannel,
      mergePeople,
    };
  }, [act, report]);
}
