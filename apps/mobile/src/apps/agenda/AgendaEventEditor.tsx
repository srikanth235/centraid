// The event editor on the phone.
//
// Title, all-day (the event's recurrence SEMANTICS, not a display toggle),
// start and end through the platform's own picker, repeat, calendar, guests
// and the reminder lead — the same seven fields the pointer editor carries.
//
// REPEAT SHOWS THE SUMMARY, NEVER THE RULE. The picker's options are named in
// words; the rule each one carries is a value on its way to `edit-event`.
//
// EDITING A REPEATING EVENT GOES THROUGH THE SCOPE PICKER: this occurrence,
// this and following, or the whole series. None of the three is the
// recommended one, so none of them is filled.

import DateTimePicker from "@react-native-community/datetimepicker";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import type { ReplicaRow } from "@centraid/client/replica/native";

import Button from "../../kit/components/Button";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { formatDateShort, formatDateTime } from "../../kit/format";
import EditorRoom from "../../kit/rooms/EditorRoom";
import { nativeEventBounds } from "../../kit/schedule/recurrence";
import type { AgendaEventModel } from "../../kit/schedule/recurrence";
import { pageMargin, radii, spacing, t, useTheme } from "../../kit/theme";
import type { NativeWriteInput } from "../../lib/replica/native-session";
import { guestOptions } from "./agenda-guests";

type Scope = "occurrence" | "future" | "series";

const SCOPES: readonly { value: Scope; label: string }[] = [
  { value: "occurrence", label: "This occurrence" },
  { value: "future", label: "This and following" },
  { value: "series", label: "The whole series" },
];

/** Repeat choices. The label is what a member reads; the rule is what the
 *  vault stores, and it is never painted. */
const REPEATS: readonly { rrule: string; label: string }[] = [
  { rrule: "", label: "Does not repeat" },
  { rrule: "FREQ=DAILY", label: "Every day" },
  { rrule: "FREQ=WEEKLY", label: "Every week" },
  { rrule: "FREQ=WEEKLY;INTERVAL=2", label: "Every other week" },
  { rrule: "FREQ=MONTHLY", label: "Every month" },
  { rrule: "FREQ=YEARLY", label: "Every year" },
];

const REMINDERS: readonly { minutes: number | null; label: string }[] = [
  { minutes: null, label: "No reminder" },
  { minutes: 10, label: "10 min before" },
  { minutes: 30, label: "30 min before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 1440, label: "1 day before" },
];

export interface EditorWrite {
  action: string;
  input: NativeWriteInput["input"];
}

function rowValue<T>(row: ReplicaRow | undefined, key: string): T | undefined {
  return row?.[key] as T | undefined;
}

function firstReminder(row: ReplicaRow | undefined): number | null {
  const raw = rowValue<string>(row, "reminders_json");
  if (!raw) return null;
  try {
    const values = JSON.parse(raw) as { minutes_before?: number }[];
    const first = Array.isArray(values) ? values[0]?.minutes_before : undefined;
    return Number.isInteger(first) ? (first as number) : null;
  } catch {
    return null;
  }
}

export default function AgendaEventEditor({
  visible,
  event,
  canonical,
  calendars,
  parties,
  attendees,
  onClose,
  onWrite,
}: {
  visible: boolean;
  event: AgendaEventModel;
  canonical?: ReplicaRow;
  calendars: readonly ReplicaRow[];
  parties: readonly ReplicaRow[];
  attendees: readonly ReplicaRow[];
  onClose: () => void;
  onWrite: (request: EditorWrite) => Promise<boolean>;
}): React.JSX.Element | null {
  const { colors } = useTheme();
  const [summary, setSummary] = useState(event.summary);
  const [description, setDescription] = useState(event.description ?? "");
  const [start, setStart] = useState(() => new Date(event.start));
  const [end, setEnd] = useState(() => new Date(event.end));
  const [allDay, setAllDay] = useState(
    () => rowValue<string>(canonical, "recurrence_semantics") === "all-day"
  );
  const [calendarId, setCalendarId] = useState(event.calendarId ?? "");
  const [rrule, setRrule] = useState(
    () => rowValue<string>(canonical, "rrule") ?? ""
  );
  const [conference, setConference] = useState(
    () => rowValue<string>(canonical, "conferencing_uri") ?? ""
  );
  const [reminder, setReminder] = useState<number | null>(() =>
    firstReminder(canonical)
  );
  const [guestIds, setGuestIds] = useState(
    () => new Set(attendees.map((attendee) => String(attendee["party_id"])))
  );
  const [scope, setScope] = useState<Scope>(
    event.isRecurrenceInstance ? "occurrence" : "series"
  );
  const [picking, setPicking] = useState<"start" | "end" | undefined>();
  const [saving, setSaving] = useState(false);

  const isRecurring = Boolean(rrule) || event.isRecurrenceInstance;
  /** AN EVENT CANNOT END BEFORE IT STARTS (#1015, audit agenda/findings#5).
   *  The editor used to validate the title and nothing else, so a start moved
   *  past the end left an inverted range on screen with Save fully armed and
   *  no warning of any kind. */
  const inverted = end.getTime() <= start.getTime();
  const RANGE_REFUSAL = "An event cannot end before it starts.";
  // People only — the enrichment runners are parties too (#1015).
  const partyOptions = useMemo(() => guestOptions(parties), [parties]);

  const submit = async (): Promise<void> => {
    // Closing an untitled draft discards it; there is nothing to write, and a
    // Save that refuses in silence is what the audit found (findings#6).
    if (!summary.trim()) {
      onClose();
      return;
    }
    if (inverted) {
      // The room hosts the line, so the refusal paints INSIDE the editor
      // rather than under it (audit B5).
      postStatus(RANGE_REFUSAL);
      return;
    }
    if (saving) return;
    setSaving(true);
    const reminders = reminder === null ? [] : [{ minutes_before: reminder }];
    const bounds = nativeEventBounds(start, end, allDay);
    const request: EditorWrite =
      isRecurring && scope !== "series"
        ? {
            // An occurrence-shaped change is an EXCEPTION on the series, keyed
            // by the instance the member opened.
            action: "edit-occurrence",
            input: {
              event_id: event.id,
              original_start_local: event.originalStart,
              scope,
              action: "override",
              dtstart: bounds.dtstart,
              dtend: bounds.dtend,
              recurrence_semantics: bounds.recurrence_semantics,
              summary: summary.trim(),
              description,
              calendar_id: calendarId,
              reminders,
              attendee_party_ids: [...guestIds],
              ...(conference ? { conferencing_uri: conference } : {}),
            },
          }
        : {
            action: "edit-event",
            input: {
              event_id: event.id,
              summary: summary.trim(),
              ...(description ? { description } : { clear_description: true }),
              ...bounds,
              ...(rrule ? { rrule } : { clear_rrule: true }),
              calendar_id: calendarId,
              ...(conference
                ? { conferencing_uri: conference }
                : { clear_conferencing: true }),
              reminders,
              attendee_party_ids: [...guestIds],
            },
          };
    const saved = await onWrite(request);
    setSaving(false);
    if (saved) onClose();
  };

  /** Skip is occurrence-shaped: the whole series is not skippable, so the
   *  control simply is not drawn for that scope. */
  const skip = async (): Promise<void> => {
    setSaving(true);
    const saved = await onWrite({
      action: "edit-occurrence",
      input: {
        event_id: event.id,
        original_start_local: event.originalStart,
        scope,
        action: "skip",
      },
    });
    setSaving(false);
    if (saved) onClose();
  };

  const chip = (
    key: string,
    label: string,
    on: boolean,
    onPress: () => void
  ): React.JSX.Element => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: on ? colors.text : colors.bgSunken },
      ]}
    >
      <Text
        style={[styles.chipText, { color: on ? colors.bg : colors.textSoft }]}
      >
        {label}
      </Text>
    </Pressable>
  );

  /** Moving the start CARRIES THE END with it: the member moved the event,
   *  not its duration, and the composer next door already thinks in hours. */
  const moveStart = (next: Date): void => {
    const held = end.getTime() - start.getTime();
    setStart(next);
    setEnd(new Date(next.getTime() + Math.max(held, 0)));
  };

  const dateField = (
    label: string,
    value: Date,
    kind: "start" | "end",
    onChange: (next: Date) => void
  ): React.JSX.Element => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.textSoft }]}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} date and time`}
        onPress={() => setPicking(kind)}
        style={[
          styles.input,
          styles.dateButton,
          { borderColor: colors.lineStrong },
        ]}
      >
        <Text style={[styles.dateText, { color: colors.text }]}>
          {allDay
            ? formatDateShort(value.toISOString())
            : formatDateTime(value)}
        </Text>
      </Pressable>
      {kind === "end" && inverted ? (
        <Text style={[styles.refusal, { color: colors.net }]}>
          {RANGE_REFUSAL}
        </Text>
      ) : null}
      {picking === kind ? (
        <DateTimePicker
          value={value}
          mode={allDay ? "date" : "datetime"}
          display="default"
          onChange={(_, next) => {
            setPicking(undefined);
            if (next) onChange(next);
          }}
        />
      ) : null}
    </View>
  );

  return (
    <EditorRoom
      cancellable={!summary.trim()}
      foot={
        isRecurring && scope !== "series" ? (
          // Destructive takes the OUTLINE, never the fill.
          <Button
            label={
              scope === "future"
                ? "Skip this and following"
                : "Skip this occurrence"
            }
            onPress={() => void skip()}
            variant="destructive"
          />
        ) : null
      }
      onDone={() => void submit()}
      presented
      title="Event"
      visible={visible}
    >
      <ScrollView contentContainerStyle={styles.content}>
        {/* THE SCOPE PICKER, first: which occurrences this change is about
              is decided before what the change is. */}
        {isRecurring ? (
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.textSoft }]}>
              This event repeats
            </Text>
            <View style={styles.chipRow}>
              {SCOPES.map((option) =>
                chip(option.value, option.label, scope === option.value, () =>
                  setScope(option.value)
                )
              )}
            </View>
          </View>
        ) : null}

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSoft }]}>Title</Text>
          <TextInput
            value={summary}
            onChangeText={setSummary}
            style={[
              styles.input,
              { borderColor: colors.lineStrong, color: colors.text },
            ]}
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSoft }]}>Notes</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            multiline
            style={[
              styles.input,
              styles.multiline,
              { borderColor: colors.lineStrong, color: colors.text },
            ]}
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSoft }]}>
            All day
          </Text>
          <View style={styles.chipRow}>
            {chip("allday-on", "All day", allDay, () => setAllDay(true))}
            {chip("allday-off", "At a time", !allDay, () => setAllDay(false))}
          </View>
        </View>

        {dateField("Starts", start, "start", moveStart)}
        {dateField("Ends", end, "end", setEnd)}

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSoft }]}>
            Repeats
          </Text>
          <View style={styles.chipRow}>
            {REPEATS.map((option) =>
              chip(
                option.rrule || "none",
                option.label,
                rrule === option.rrule,
                () => setRrule(option.rrule)
              )
            )}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSoft }]}>
            Calendar
          </Text>
          <View style={styles.chipRow}>
            {calendars.map((calendar) => {
              const id = String(calendar["calendar_id"]);
              return chip(
                id,
                String(calendar["name"] ?? "Calendar"),
                calendarId === id,
                () => setCalendarId(id)
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSoft }]}>
            Reminder
          </Text>
          <View style={styles.chipRow}>
            {REMINDERS.map((option) =>
              chip(
                String(option.minutes ?? "none"),
                option.label,
                reminder === option.minutes,
                () => setReminder(option.minutes)
              )
            )}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSoft }]}>
            Joining link
          </Text>
          <TextInput
            value={conference}
            onChangeText={setConference}
            autoCapitalize="none"
            style={[
              styles.input,
              { borderColor: colors.lineStrong, color: colors.text },
            ]}
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.textSoft }]}>Guests</Text>
          <View style={styles.chipRow}>
            {partyOptions.map((party) =>
              chip(party.id, party.name, guestIds.has(party.id), () =>
                setGuestIds((current) => {
                  const next = new Set(current);
                  if (next.has(party.id)) next.delete(party.id);
                  else next.add(party.id);
                  return next;
                })
              )
            )}
          </View>
        </View>
      </ScrollView>
    </EditorRoom>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radii.pill,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing[4],
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipText: { ...t("control") },
  content: {
    gap: spacing[3],
    paddingBottom: spacing[6],
    paddingHorizontal: pageMargin,
    paddingTop: spacing[3],
  },
  dateButton: { justifyContent: "center" },
  dateText: { ...t("body") },
  field: { gap: 5 },
  input: {
    ...t("body"),
    borderRadius: radii.md,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  label: { ...t("eyebrow") },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  refusal: { ...t("small") },
});
