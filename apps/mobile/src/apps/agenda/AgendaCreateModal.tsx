// The create composer on the phone. Title, when, calendar, guests — the same
// seven fields the editor carries, minus the ones a brand-new event has no
// answer for yet.
//
// The date and time come from the platform's own picker
// (`@react-native-community/datetimepicker`), never from a typed string: a
// member on a phone should not be spelling an ISO instant, and the picker is
// what the `DateTimeField` recipe lowers to on this seat.

import DateTimePicker from "@react-native-community/datetimepicker";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import { Text, TextInput } from "../../kit/components/NativeText";
import { formatDateTime } from "../../kit/format";
import EditorRoom from "../../kit/rooms/EditorRoom";
import { pageMargin, radii, spacing, t, useTheme } from "../../kit/theme";
import { guestOptions } from "./agenda-guests";

/** The `propose` payload, in the shape the native write path takes. The
 *  vault's own input schema (app.json) is the contract; this is the local
 *  spelling of it. */
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
}): React.JSX.Element | null {
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
  // People only — the enrichment runners are parties too (#1015).
  const guestChoices = useMemo(() => guestOptions(parties), [parties]);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  // NO DEAD SAVE (#1015, audit agenda/findings#6). The composer used to draw
  // an always-armed "Save" over a silent `if (!summary.trim()) return;`, so
  // pressing it on the state the sheet ALWAYS opens in did nothing visible at
  // all. Under D3 there is no Save: an untitled draft has nothing to write, so
  // the leave key is an honest "Cancel"; once it has a title, closing saves.
  const ready = summary.trim().length > 0 && calendarId.length > 0;

  const submit = async (): Promise<void> => {
    if (!ready) {
      onClose();
      return;
    }
    if (saving) return;
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
    <EditorRoom
      cancellable={!ready}
      onDone={() => void submit()}
      presented
      title="New event"
      visible={visible}
    >
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
            {formatDateTime(start)}
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

        <Text style={[styles.label, { color: colors.textSoft }]}>Calendar</Text>
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
          {guestChoices.map(({ id, name }) => {
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
    </EditorRoom>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radii.pill,
    minHeight: 44,
    justifyContent: "center",
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
  input: {
    ...t("body"),
    borderRadius: radii.md,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  label: { ...t("eyebrow") },
});
