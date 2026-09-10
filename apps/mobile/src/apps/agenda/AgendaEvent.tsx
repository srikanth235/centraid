// One event on the phone: what it is, who is coming, the member's own RSVP,
// what is held about it, and the two verbs — Edit, and Ask to cancel.
//
// PARKED CANCEL IS A STATE, NOT AN ERROR. Cancelling is medium-risk, so the
// vault HOLDS the ask for the owner rather than executing it. The event stays
// on the agenda, this screen says what is held, and the way on is Approvals —
// the owner's own surface. There is deliberately no unpark control: the
// vault's release door is the owner's, and a button that could not act would
// be worse than the sentence naming who decides.

import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import {
  pendingSidecarOf,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import {
  PARTSTAT_CHOOSE,
  PENDING_CANCEL_CHIP,
  PENDING_MARK,
  partstatLabel,
} from "@centraid/blueprints/apps/agenda/view-copy";

import { useBandOwner } from "../../kit/band/band-owner";
import { useConfirmDestructive } from "../../kit/components/ConfirmSheet";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { formatTime } from "../../kit/format";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  READ_ONLY_SOURCE_REASON,
  rowCanWrite,
} from "../../kit/replica/row-provenance";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { placeStack, parentPlace } from "../../kit/rooms/place";
import PushedPage from "../../kit/rooms/PushedPage";
import { TEST_IDS } from "../../kit/test-ids";
import { pageMargin, radii, spacing, t, useTheme } from "../../kit/theme";
import type { NativeWriteInput } from "../../lib/replica/native-session";
import type { AgendaScreenProps } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import AgendaBand from "./AgendaBand";
import AgendaEventEditor from "./AgendaEventEditor";
import { useAgenda } from "./useAgenda";

// The blueprint owns the enum's words; this is the order the chips take.
const RSVP: readonly { partstat: string; label: string }[] = Object.entries(
  PARTSTAT_CHOOSE
).map(([partstat, label]) => ({ label, partstat }));

export default function AgendaEvent({
  route,
  navigation,
}: AgendaScreenProps<"AgendaEvent">): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const { confirmDestructive, confirmSheet } = useConfirmDestructive();
  // One latch per app: a handback on the list is a handback here too.
  const { bandOwner } = useBandOwner("agenda");
  const { eventId, instanceKey } = route.params;
  // One event is looked up across the whole replicated series, so a recurrence
  // instance years out still resolves. The expansion is bounded by the engine's
  // own instance cap, not by this range.
  const range = useMemo(
    () => [new Date("1970-01-01"), new Date("2100-01-01")] as const,
    []
  );
  const agenda = useAgenda(range[0], range[1]);

  const canonical = agenda.canonicalEvents.find(
    (row) => row["event_id"] === eventId
  );
  const extension = agenda.eventExtensions.find(
    (row) => row["event_id"] === eventId
  );
  const editable = { ...canonical, ...extension };
  // Render the tapped OCCURRENCE when an instance key was threaded through, so
  // a recurring instance shows its own date. Writes still target the series.
  const event =
    (instanceKey
      ? agenda.events.find((row) => row.instanceKey === instanceKey)
      : undefined) ?? agenda.events.find((row) => row.id === eventId);

  const [editOpen, setEditOpen] = useState(false);

  const partyNames = new Map(
    agenda.parties.map((row) => [
      String(row["party_id"]),
      String(row["display_name"] ?? row["name"] ?? "Guest"),
    ])
  );
  const attendees = agenda.attendees.filter(
    (row) => row["event_id"] === eventId
  );
  // RSVP acts as the vault OWNER's own attendee row, never `attendees[0]`. If
  // the owner is not on the guest list there is no honest party to answer as.
  const me = agenda.ownerPartyId;
  const myAttendee = attendees.find(
    (row) => me !== undefined && String(row["party_id"]) === String(me)
  );

  const writable = rowCanWrite(canonical);

  const canonicalRow = (canonical ?? {}) as unknown as Record<string, unknown>;
  const pending = readPendingOverlay(
    canonicalRow,
    pendingSidecarOf(canonicalRow)
  );
  const heldCancel =
    pending?.action === "cancel-event" &&
    (pending.status === "queued" ||
      pending.status === "sending" ||
      pending.status === "parked");

  const apply = (
    result: Parameters<typeof surfaceWriteOutcome>[0],
    verb: string
  ): boolean =>
    surfaceWriteOutcome(result, {
      failureTitle: `${verb} not applied`,
      onParked: () => navigation.navigate("Settings", { screen: "Approvals" }),
      queuedMessage: `${verb} saved on this device until the gateway answers.`,
    });

  const writeEdit = async (request: {
    action: string;
    input: NativeWriteInput["input"];
  }): Promise<boolean> => {
    if (!session) return false;
    try {
      const result = await session.write("agenda", request);
      return apply(result, "Event edit");
    } catch (error) {
      surfaceWriteFailure(error, "Event edit failed");
      return false;
    }
  };

  const cancel = async (): Promise<void> => {
    if (!event || !session) return;
    try {
      const result = await session.write("agenda", {
        action: "cancel-event",
        input: { event_id: event.id },
      });
      apply(result, "Cancellation");
    } catch (error) {
      surfaceWriteFailure(error, "Cancellation failed");
    }
  };

  const rsvp = async (partstat: string): Promise<void> => {
    const partyId = String(myAttendee?.["party_id"] ?? "");
    if (!partyId || !session || !event) return;
    try {
      const result = await session.write("agenda", {
        action: "rsvp",
        input: { event_id: event.id, party_id: partyId, partstat },
      });
      apply(result, "RSVP");
    } catch (error) {
      surfaceWriteFailure(error, "RSVP failed");
    }
  };

  // THE TWO FACTS TRUE ON EVERY ROUTE (#1015, audit agenda/findings#8). This
  // screen mounted neither the vault lockup nor the replica line nor a band,
  // on the one Agenda surface offering a write whose behaviour depends on
  // exactly which vault and which gateway. The room carries all three.
  const band = (): React.JSX.Element => (
    <AgendaBand
      owner={bandOwner}
      onSelect={(key) => {
        // `search` and `more` open a field and a sheet on the list rather
        // than being places, so from here they are simply the list.
        if (key === "day" || key === "schedule" || key === "waiting")
          navigation.popTo("AgendaHome", { destination: key });
        else navigation.popTo("AgendaHome");
      }}
      // HOME via popTo — `goBack()` is a no-op under a deep link and
      // `navigate` pushes a second Home on React Navigation 7.
      onHome={() => navigation.popTo("Home")}
    />
  );
  const stack = placeStack([
    { key: "AgendaHome", title: "Agenda" },
    { key: "AgendaEvent", title: "Event" },
  ]);

  return (
    <PushedPage
      backTo={parentPlace(stack)}
      backTestID={TEST_IDS.agenda.eventBack}
      band={band}
      chrome={
        <>
          <VaultBar />
          <ReplicaStatusBar />
        </>
      }
      onBack={() => navigation.goBack()}
      overlay={
        <>
          {editOpen && event ? (
            <AgendaEventEditor
              visible
              event={event}
              canonical={editable}
              calendars={agenda.calendars}
              parties={agenda.parties}
              attendees={attendees}
              onClose={() => setEditOpen(false)}
              onWrite={writeEdit}
            />
          ) : null}
          {confirmSheet}
        </>
      }
      title="Event"
      {...(event
        ? {}
        : {
            loading: { label: "Reading this event", rows: 4 },
          })}
    >
      {event ? (
        <ScrollView contentContainerStyle={styles.content}>
          {writable ? null : (
            <Text style={[styles.readOnly, { color: colors.net }]}>
              {READ_ONLY_SOURCE_REASON}
            </Text>
          )}
          <Text style={[styles.date, { color: colors.textSoft }]}>
            {new Intl.DateTimeFormat(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            }).format(new Date(event.start))}
          </Text>
          <Text style={[styles.title, { color: colors.text }]}>
            {event.summary}
          </Text>
          <Text style={[styles.when, { color: colors.textSoft }]}>
            {formatTime(event.start)}
            {" – "}
            {formatTime(event.end)}
          </Text>
          {event.description ? (
            <Text style={[styles.description, { color: colors.text }]}>
              {event.description}
            </Text>
          ) : null}

          {/* The held-write mark, drawn inline: a 2pt rule on the reading edge
            and the words beside it. */}
          {pending ? (
            <View
              style={[
                styles.pendingMark,
                { borderStartColor: colors.textFaint },
              ]}
            >
              <Text style={[styles.pendingText, { color: colors.textSoft }]}>
                {heldCancel ? PENDING_CANCEL_CHIP : PENDING_MARK}
              </Text>
            </View>
          ) : null}

          {/* PARKED CANCEL — what the vault holds, and who releases it. */}
          {heldCancel ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Review this cancellation in Approvals"
              style={[styles.parked, { borderStartColor: colors.seam }]}
              onPress={() =>
                navigation.navigate("Settings", { screen: "Approvals" })
              }
            >
              <Text style={[styles.parkedTitle, { color: colors.text }]}>
                Cancellation held for the owner
              </Text>
              <Text style={[styles.parkedBody, { color: colors.textSoft }]}>
                The event stays on the agenda until the owner approves it.
              </Text>
            </Pressable>
          ) : null}

          <Text style={[styles.section, { color: colors.textSoft }]}>
            Guests
          </Text>
          {attendees.length > 0 ? (
            attendees.map((attendee) => (
              <View
                key={String(attendee["attendee_id"] ?? attendee["party_id"])}
                style={[styles.guest, { borderBottomColor: colors.line }]}
              >
                <Text style={[styles.guestName, { color: colors.text }]}>
                  {partyNames.get(String(attendee["party_id"])) ?? "Guest"}
                </Text>
                <Text style={[styles.guestState, { color: colors.textSoft }]}>
                  {partstatLabel(attendee["partstat"])}
                </Text>
              </View>
            ))
          ) : (
            <Text style={[styles.empty, { color: colors.textSoft }]}>
              Nobody else is on this event.
            </Text>
          )}

          {myAttendee ? (
            <View style={styles.rsvpRow}>
              {RSVP.map((answer) => (
                <Pressable
                  key={answer.partstat}
                  accessibilityRole="button"
                  accessibilityLabel={answer.label}
                  accessibilityState={{
                    disabled: !writable,
                    selected:
                      String(myAttendee["partstat"] ?? "") === answer.partstat,
                  }}
                  accessibilityHint={
                    writable ? undefined : READ_ONLY_SOURCE_REASON
                  }
                  disabled={!writable}
                  style={[
                    styles.rsvpButton,
                    {
                      borderColor: writable ? colors.lineStrong : colors.line,
                    },
                  ]}
                  onPress={() => void rsvp(answer.partstat)}
                >
                  <Text
                    style={[
                      styles.rsvpText,
                      { color: writable ? colors.text : colors.textDisabled },
                    ]}
                  >
                    {answer.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit this event"
            accessibilityState={{ disabled: !writable }}
            accessibilityHint={writable ? undefined : READ_ONLY_SOURCE_REASON}
            disabled={!writable}
            style={[styles.action, { borderBottomColor: colors.line }]}
            onPress={() => setEditOpen(true)}
          >
            <Icon
              name="Pencil"
              size={18}
              color={writable ? colors.text : colors.textDisabled}
            />
            <Text
              style={[
                styles.actionText,
                { color: writable ? colors.text : colors.textDisabled },
              ]}
            >
              Edit event
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ask to cancel this event"
            accessibilityState={{ disabled: !writable }}
            accessibilityHint={writable ? undefined : READ_ONLY_SOURCE_REASON}
            disabled={!writable}
            style={[styles.action, { borderBottomColor: colors.line }]}
            onPress={() =>
              confirmDestructive({
                body: "The event stays visible until the owner approves this medium-risk write.",
                noun: "event",
                onConfirm: () => void cancel(),
                verb: "Ask to cancel",
              })
            }
          >
            <Icon
              name="XCircle"
              size={18}
              color={writable ? colors.danger : colors.textDisabled}
            />
            <Text
              style={[
                styles.actionText,
                { color: writable ? colors.danger : colors.textDisabled },
              ]}
            >
              Ask to cancel
            </Text>
          </Pressable>
        </ScrollView>
      ) : null}
    </PushedPage>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 48,
  },
  actionText: { ...t("body"), flex: 1 },
  content: {
    gap: spacing[3],
    paddingBottom: spacing[6],
    paddingHorizontal: pageMargin,
    paddingTop: spacing[3],
  },
  date: { ...t("eyebrow") },
  description: { ...t("reading") },
  empty: { ...t("body") },
  guest: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 44,
  },
  guestName: { ...t("body"), flex: 1 },
  guestState: { ...t("annotLabel") },
  parked: {
    borderRadius: radii.md,
    borderStartWidth: 2,
    gap: spacing[1],
    padding: spacing[3],
  },
  parkedBody: { ...t("body") },
  parkedTitle: { ...t("bodyStrong") },
  pendingMark: { borderStartWidth: 2, paddingStart: 8 },
  pendingText: { ...t("annotLabel") },
  readOnly: { ...t("annotLabel"), marginBottom: 8 },
  rsvpButton: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  rsvpRow: { flexDirection: "row", gap: 8 },
  rsvpText: { ...t("control") },
  section: { ...t("eyebrow"), marginTop: 12 },
  title: { ...t("title") },
  when: { ...t("mono") },
});
