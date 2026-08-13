import DateTimePicker from "@react-native-community/datetimepicker";
import React, { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { family, useTheme, radii, t } from "../../kit/theme";

type TimeSemantics = "zoned" | "floating" | "all-day";
export type AgendaCreateInput = Record<string, ReplicaValue>;

function initialRange(): { start: string; end: string } {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export default function AgendaCreateModal({
  visible,
  calendars,
  parties,
  defaultCalendarId,
  onClose,
  onCreate,
}: {
  visible: boolean;
  calendars: ReplicaRow[];
  parties: ReplicaRow[];
  defaultCalendarId: string;
  onClose: () => void;
  onCreate: (input: AgendaCreateInput) => Promise<boolean>;
}): React.JSX.Element {
  const { colors } = useTheme();
  const initial = initialRange();
  const localZone =
    new Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [startTz, setStartTz] = useState(localZone);
  const [endTz, setEndTz] = useState(localZone);
  const [semantics, setSemantics] = useState<TimeSemantics>("zoned");
  const [calendarId, setCalendarId] = useState(defaultCalendarId);
  const [rrule, setRrule] = useState("");
  const [location, setLocation] = useState("");
  const [conference, setConference] = useState("");
  const [reminders, setReminders] = useState("15");
  const [guestIds, setGuestIds] = useState(new Set<string>());
  const [saving, setSaving] = useState(false);
  const [datePicker, setDatePicker] = useState<"start" | "end">();
  const partyOptions = useMemo(
    () =>
      parties.map((party) => ({
        id: String(party.party_id),
        name: String(party.display_name ?? party.name ?? "Person"),
      })),
    [parties]
  );

  const submit = async (): Promise<void> => {
    if (
      !summary.trim() ||
      !calendarId ||
      Number.isNaN(Date.parse(start)) ||
      Number.isNaN(Date.parse(end)) ||
      Date.parse(end) <= Date.parse(start)
    ) {
      return;
    }
    const reminderRows = reminders
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0)
      .map((minutes_before) => ({ minutes_before }));
    setSaving(true);
    const created = await onCreate({
      summary: summary.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      dtstart: start,
      dtend: end,
      start_tz: startTz.trim() || localZone,
      end_tz: endTz.trim() || startTz.trim() || localZone,
      recurrence_semantics: semantics,
      calendar_id: calendarId,
      ...(rrule.trim() ? { rrule: rrule.trim() } : {}),
      ...(location.trim() ? { location_place_id: location.trim() } : {}),
      ...(conference.trim() ? { conferencing_uri: conference.trim() } : {}),
      reminders: reminderRows,
      attendee_party_ids: [...guestIds],
    });
    setSaving(false);
    if (created) onClose();
  };

  const field = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    options?: { multiline?: boolean; autoFocus?: boolean }
  ) => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.textSoft }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoFocus={options?.autoFocus}
        multiline={options?.multiline}
        value={value}
        onChangeText={onChangeText}
        style={[
          styles.input,
          options?.multiline && styles.multiline,
          { borderColor: colors.lineStrong, color: colors.text },
        ]}
      />
    </View>
  );

  const dateField = (
    label: string,
    value: string,
    kind: "start" | "end",
    onChange: (next: string) => void
  ): React.JSX.Element => {
    const date = new Date(value);
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    return (
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSoft }]}>{label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} date and time`}
          onPress={() => setDatePicker(kind)}
          style={[
            styles.dateButton,
            { borderColor: colors.lineStrong, backgroundColor: colors.bgElev },
          ]}
        >
          <Text style={[styles.dateText, { color: colors.text }]}>
            {safeDate.toLocaleString()}
          </Text>
        </Pressable>
        {datePicker === kind ? (
          <DateTimePicker
            value={safeDate}
            mode="datetime"
            display="default"
            onChange={(_, next) => {
              setDatePicker(undefined);
              if (next) onChange(next.toISOString());
            }}
          />
        ) : null}
      </View>
    );
  };

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
            accessibilityLabel="Close event composer"
            onPress={onClose}
          >
            <Icon name="x" size={23} color={colors.text} />
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>New event</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create tentative event"
            accessibilityState={{ disabled: saving }}
            disabled={saving}
            onPress={() => void submit()}
          >
            <Text style={[styles.save, { color: colors.accent }]}>
              {saving ? "Creating…" : "Create"}
            </Text>
          </Pressable>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {field("Title", summary, setSummary, { autoFocus: true })}
          {field("Description", description, setDescription, {
            multiline: true,
          })}
          {dateField("Start", start, "start", setStart)}
          {dateField("End", end, "end", setEnd)}
          {field("Start timezone", startTz, setStartTz)}
          {field("End timezone", endTz, setEndTz)}
          <Text style={[styles.label, { color: colors.textSoft }]}>
            Time semantics
          </Text>
          <View style={styles.chips}>
            {(["zoned", "floating", "all-day"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: semantics === value }}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      semantics === value ? colors.text : colors.bgSunken,
                  },
                ]}
                onPress={() => setSemantics(value)}
              >
                <Text
                  style={[
                    styles.chipText,
                    {
                      color: semantics === value ? colors.bg : colors.textSoft,
                    },
                  ]}
                >
                  {value}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.label, { color: colors.textSoft }]}>
            Calendar
          </Text>
          <View style={styles.chips}>
            {calendars.map((calendar) => {
              const id = String(calendar.calendar_id);
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: calendarId === id }}
                  style={[
                    styles.chip,
                    {
                      backgroundColor:
                        calendarId === id ? colors.text : colors.bgSunken,
                    },
                  ]}
                  onPress={() => setCalendarId(id)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      {
                        color: calendarId === id ? colors.bg : colors.textSoft,
                      },
                    ]}
                  >
                    {String(calendar.name ?? "Calendar")}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {field("RRULE", rrule, setRrule)}
          <Text style={[styles.help, { color: colors.textFaint }]}>
            Example: FREQ=WEEKLY;BYDAY=MO,WE
          </Text>
          {field("Location place ID", location, setLocation)}
          {field("Video call URL", conference, setConference)}
          {field("Reminder minutes", reminders, setReminders)}
          <Text style={[styles.help, { color: colors.textFaint }]}>
            Comma-separated minutes before the event. Leave blank for none.
          </Text>
          <Text style={[styles.label, { color: colors.textSoft }]}>Guests</Text>
          <View style={styles.chips}>
            {partyOptions.map((party) => (
              <Pressable
                key={party.id}
                accessibilityRole="button"
                accessibilityState={{ selected: guestIds.has(party.id) }}
                style={[
                  styles.chip,
                  {
                    backgroundColor: guestIds.has(party.id)
                      ? colors.text
                      : colors.bgSunken,
                  },
                ]}
                onPress={() =>
                  setGuestIds((current) => {
                    const next = new Set(current);
                    if (next.has(party.id)) next.delete(party.id);
                    else next.add(party.id);
                    return next;
                  })
                }
              >
                <Text
                  style={[
                    styles.chipText,
                    {
                      color: guestIds.has(party.id)
                        ? colors.bg
                        : colors.textSoft,
                    },
                  ]}
                >
                  {party.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radii.pill,
    minHeight: 34,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  chipText: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  content: { gap: 12, padding: 20, paddingBottom: 60 },
  field: { gap: 5 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 54,
    paddingHorizontal: 18,
  },
  help: {
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
    marginTop: -7,
  },
  input: {
    borderRadius: radii.lg,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dateButton: {
    borderRadius: radii.lg,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  dateText: { fontFamily: family.sansRegular, fontSize: t("body").fontSize },
  label: {
    fontFamily: family.sansMedium,
    fontSize: t("mono").fontSize,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  safe: { flex: 1 },
  save: { fontFamily: family.sansMedium, fontSize: t("body").fontSize },
  title: { fontFamily: family.sansMedium, fontSize: t("body").fontSize },
});
