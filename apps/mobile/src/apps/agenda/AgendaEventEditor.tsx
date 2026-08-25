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
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import type { ReplicaRow } from "@centraid/client/replica/native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import type { AgendaEventModel } from "../../kit/schedule/recurrence";
import { radii, t, useTheme } from "../../kit/theme";
import type { NativeWriteInput } from "../../lib/replica/native-session";

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
}): React.JSX.Element {
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
  const partyOptions = useMemo(
    () =>
      parties.map((party) => ({
        id: String(party["party_id"]),
        name: String(party["display_name"] ?? party["name"] ?? "Person"),
      })),
    [parties]
  );

  const submit = async (): Promise<void> => {
    if (!summary.trim()) return;
    setSaving(true);
    const reminders = reminder === null ? [] : [{ minutes_before: reminder }];
    const request: EditorWrite =
      isRecurring && scope !== "series"
        ? {
            // An occurrence-shaped change is an EXCEPTION on the series, keyed
            // by the instance the member opened.
            action: "edit-occurrence",
            input: {
              event_id: event.id,
              original_start: event.originalStart,
              scope,
              action: "override",
              dtstart: start.toISOString(),
              dtend: end.toISOString(),
              summary: summary.trim(),
              description,
            },
          }
        : {
            action: "edit-event",
            input: {
              event_id: event.id,
              summary: summary.trim(),
              ...(description ? { description } : { clear_description: true }),
              dtstart: start.toISOString(),
              dtend: end.toISOString(),
              recurrence_semantics: allDay ? "all-day" : "zoned",
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
        original_start: event.originalStart,
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
          {allDay ? value.toLocaleDateString() : value.toLocaleString()}
        </Text>
      </Pressable>
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
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.safe, { backgroundColor: colors.bg }]}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close the editor"
            onPress={onClose}
          >
            <Icon name="X" size={23} color={colors.text} />
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Event</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save this event"
            accessibilityState={{ disabled: saving }}
            disabled={saving}
            onPress={() => void submit()}
          >
            <Text style={[styles.save, { color: colors.text }]}>
              {saving ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        </View>

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
            <Text style={[styles.label, { color: colors.textSoft }]}>
              Title
            </Text>
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
            <Text style={[styles.label, { color: colors.textSoft }]}>
              Notes
            </Text>
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

          {dateField("Starts", start, "start", setStart)}
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
            <Text style={[styles.label, { color: colors.textSoft }]}>
              Guests
            </Text>
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

          {isRecurring && scope !== "series" ? (
            // Destructive takes the OUTLINE, never the fill.
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Skip this occurrence"
              style={[styles.skip, { borderColor: colors.danger }]}
              onPress={() => void skip()}
            >
              <Text style={[styles.skipText, { color: colors.danger }]}>
                {scope === "future"
                  ? "Skip this and following"
                  : "Skip this occurrence"}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radii.pill,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 14,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipText: { ...t("control") },
  content: { gap: 12, padding: 20, paddingBottom: 60 },
  dateButton: { justifyContent: "center" },
  dateText: { ...t("body") },
  field: { gap: 5 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 54,
    paddingHorizontal: 18,
  },
  input: {
    ...t("body"),
    borderRadius: radii.md,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  label: { ...t("eyebrow") },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  safe: { flex: 1 },
  save: { ...t("bodyStrong") },
  skip: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: 12,
    minHeight: 44,
    justifyContent: "center",
    padding: 12,
  },
  skipText: { ...t("control") },
  title: { ...t("bodyStrong") },
});
