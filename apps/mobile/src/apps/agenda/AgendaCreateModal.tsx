import DateTimePicker from "@react-native-community/datetimepicker";
import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import Tappable from "../../kit/components/Tappable";
import { radii, t, useTheme } from "../../kit/theme";

export type AgendaCreateInput = Record<string, ReplicaValue>;

const HOUR_MS = 60 * 60 * 1000;

export default function AgendaCreateModal({
  visible,
  calendars,
  parties,
  defaultCalendarId,
  onClose,
  onCreate,
}: {
  visible: boolean;
  calendars: readonly ReplicaRow[];
  parties: readonly ReplicaRow[];
  defaultCalendarId: string;
  onClose: () => void;
  onCreate: (input: AgendaCreateInput) => Promise<boolean>;
}): React.JSX.Element {
  const { colors } = useTheme();
  const [summary, setSummary] = useState("");
  const [start, setStart] = useState(() => {
    const next = new Date();
    next.setMinutes(Math.floor(next.getMinutes() / 30) * 30 + 30, 0, 0);
    return next;
  });
  const [durationHours, setDurationHours] = useState(1);
  const [calendarId, setCalendarId] = useState(defaultCalendarId);
  const [guests, setGuests] = useState<Set<string>>(() => new Set());
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    if (!summary.trim() || !calendarId) return;
    setSaving(true);
    const created = await onCreate({
      summary: summary.trim(),
      dtstart: start.toISOString(),
      dtend: new Date(start.getTime() + durationHours * HOUR_MS).toISOString(),
      start_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      calendar_id: calendarId,
      attendee_party_ids: [...guests],
    });
    setSaving(false);
    if (created) onClose();
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
          <Tappable
            accessibilityRole="button"
            accessibilityLabel="Close the composer"
            onPress={onClose}
          >
            <Icon name="X" size={23} color={colors.text} />
          </Tappable>
          <Text style={[styles.title, { color: colors.text }]}>New event</Text>
          <Tappable
            accessibilityRole="button"
            accessibilityLabel="Save this event"
            disabled={saving}
            onPress={() => void submit()}
          >
            <Text style={[styles.save, { color: colors.text }]}>
              {saving ? "Saving…" : "Save"}
            </Text>
          </Tappable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.label, { color: colors.textSoft }]}>Title</Text>
          <TextInput
            autoFocus
            value={summary}
            onChangeText={setSummary}
            style={[
              styles.input,
              { borderColor: colors.lineStrong, color: colors.text },
            ]}
          />

          <Text style={[styles.label, { color: colors.textSoft }]}>Starts</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start date and time"
            onPress={() => setPicking(true)}
            style={[
              styles.input,
              styles.dateButton,
              { borderColor: colors.lineStrong },
            ]}
          >
            <Text style={[styles.dateText, { color: colors.text }]}>
              {start.toLocaleString()}
            </Text>
          </Pressable>
          {picking ? (
            <DateTimePicker
              value={start}
              mode="datetime"
              display="default"
              onChange={(_, next) => {
                setPicking(false);
                if (next) setStart(next);
              }}
            />
          ) : null}

          <Text style={[styles.label, { color: colors.textSoft }]}>Ends</Text>
          <View style={styles.chipRow}>
            {[1, 2, 4].map((hours) => (
              <Pressable
                key={hours}
                accessibilityRole="button"
                accessibilityLabel={`${hours} hour${hours === 1 ? "" : "s"} long`}
                accessibilityState={{ selected: durationHours === hours }}
                onPress={() => setDurationHours(hours)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      durationHours === hours ? colors.text : colors.bgSunken,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    {
                      color:
                        durationHours === hours ? colors.bg : colors.textSoft,
                    },
                  ]}
                >
                  {hours}h
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.label, { color: colors.textSoft }]}>
            Calendar
          </Text>
          <View style={styles.chipRow}>
            {calendars.map((calendar) => {
              const id = String(calendar["calendar_id"] ?? "");
              const on = calendarId === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={String(calendar["name"] ?? "Calendar")}
                  accessibilityState={{ selected: on }}
                  onPress={() => setCalendarId(id)}
                  style={[
                    styles.chip,
                    { backgroundColor: on ? colors.text : colors.bgSunken },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      { color: on ? colors.bg : colors.textSoft },
                    ]}
                  >
                    {String(calendar["name"] ?? "Calendar")}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.label, { color: colors.textSoft }]}>Guests</Text>
          <View style={styles.chipRow}>
            {parties.map((party) => {
              const id = String(party["party_id"] ?? "");
              const name = String(
                party["display_name"] ?? party["name"] ?? "Person"
              );
              const on = guests.has(id);
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={name}
                  accessibilityState={{ selected: on }}
                  onPress={() =>
                    setGuests((current) => {
                      const next = new Set(current);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  style={[
                    styles.chip,
                    { backgroundColor: on ? colors.text : colors.bgSunken },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      { color: on ? colors.bg : colors.textSoft },
                    ]}
                  >
                    {name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radii.pill,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipText: { ...t("control") },
  content: { gap: 10, padding: 20, paddingBottom: 60 },
  dateButton: { justifyContent: "center" },
  dateText: { ...t("body") },
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
  safe: { flex: 1 },
  save: { ...t("bodyStrong") },
  title: { ...t("bodyStrong") },
});
