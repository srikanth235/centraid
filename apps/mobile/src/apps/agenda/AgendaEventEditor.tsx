import { Feather } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { ReplicaRow } from "@centraid/client/replica/native";

import { family, useTheme } from "../../kit/theme";
import type { NativeWriteInput } from "../../lib/replica/native-session";
import type { AgendaEventModel } from "./recurrence";

type Scope = "occurrence" | "future" | "series";

interface EditorWrite {
  action: string;
  input: NativeWriteInput["input"];
  optimistic: NonNullable<NativeWriteInput["optimistic"]>;
}

function rowValue<T>(row: ReplicaRow | undefined, key: string): T | undefined {
  return row?.[key] as T | undefined;
}

function canonicalValues(row: ReplicaRow | undefined): ReplicaRow {
  if (!row) return {};
  const { __rowId: _rowId, ...values } = row;
  return values;
}

function remindersOf(row: ReplicaRow | undefined): string {
  const raw = rowValue<string>(row, "reminders_json");
  if (!raw) return "";
  try {
    const values = JSON.parse(raw) as { minutes_before?: number }[];
    return values
      .map((value) => value.minutes_before)
      .filter((value): value is number => Number.isInteger(value))
      .join(", ");
  } catch {
    return "";
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
  calendars: ReplicaRow[];
  parties: ReplicaRow[];
  attendees: ReplicaRow[];
  onClose: () => void;
  onWrite: (request: EditorWrite) => Promise<boolean>;
}): React.JSX.Element {
  const { colors } = useTheme();
  const [summary, setSummary] = useState(event.summary);
  const [description, setDescription] = useState(event.description ?? "");
  const [start, setStart] = useState(event.start);
  const [end, setEnd] = useState(event.end);
  const [startTz, setStartTz] = useState(
    rowValue<string>(canonical, "start_tz") ?? "Etc/UTC"
  );
  const [endTz, setEndTz] = useState(
    rowValue<string>(canonical, "end_tz") ??
      rowValue<string>(canonical, "start_tz") ??
      "Etc/UTC"
  );
  const [semantics, setSemantics] = useState(
    rowValue<"zoned" | "floating" | "all-day">(
      canonical,
      "recurrence_semantics"
    ) ?? "zoned"
  );
  const [calendarId, setCalendarId] = useState(event.calendarId ?? "");
  const [rrule, setRrule] = useState(
    rowValue<string>(canonical, "rrule") ?? ""
  );
  const [location, setLocation] = useState(
    rowValue<string>(canonical, "location_place_id") ?? ""
  );
  const [conference, setConference] = useState(
    rowValue<string>(canonical, "conferencing_uri") ?? ""
  );
  const [reminders, setReminders] = useState(remindersOf(canonical));
  const [guestIds, setGuestIds] = useState(
    new Set(attendees.map((attendee) => String(attendee.party_id)))
  );
  const [scope, setScope] = useState<Scope>(
    event.isRecurrenceInstance ? "occurrence" : "series"
  );
  const [saving, setSaving] = useState(false);
  const isRecurring = Boolean(rrule);
  const originalStart = event.originalStart;
  const partyOptions = useMemo(
    () =>
      parties.map((party) => ({
        id: String(party.party_id),
        name: String(party.display_name ?? party.name ?? "Person"),
      })),
    [parties]
  );

  const submit = async (): Promise<void> => {
    if (!summary.trim() || Number.isNaN(Date.parse(start))) return;
    setSaving(true);
    const reminderRows = reminders
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0)
      .map((minutes_before) => ({ minutes_before }));
    let request: EditorWrite;
    if (isRecurring && scope !== "series") {
      request = {
        action: "edit-occurrence",
        input: {
          event_id: event.id,
          original_start: originalStart,
          scope,
          action: "override",
          dtstart: start,
          dtend: end,
          summary: summary.trim(),
          description,
        },
        optimistic: [
          {
            op: "upsert",
            entity: "schedule.recurrence_exception",
            rowId: `pending:${event.id}:${originalStart}`,
            values: {
              exception_id: `pending:${event.id}:${originalStart}`,
              target_type: "core.event",
              target_id: event.id,
              original_start: originalStart,
              action: "override",
              override_json: JSON.stringify({
                scope,
                start,
                end,
                summary: summary.trim(),
                description,
              }),
            },
          },
        ],
      };
    } else {
      request = {
        action: "edit-event",
        input: {
          event_id: event.id,
          summary: summary.trim(),
          ...(description ? { description } : { clear_description: true }),
          dtstart: start,
          dtend: end,
          start_tz: startTz,
          end_tz: endTz,
          recurrence_semantics: semantics,
          ...(rrule ? { rrule } : { clear_rrule: true }),
          calendar_id: calendarId,
          ...(location
            ? { location_place_id: location }
            : { clear_location: true }),
          ...(conference
            ? { conferencing_uri: conference }
            : { clear_conferencing: true }),
          reminders: reminderRows,
          attendee_party_ids: [...guestIds],
        },
        optimistic: [
          {
            op: "upsert",
            entity: "core.event",
            rowId: event.id,
            values: {
              ...canonicalValues(canonical),
              summary: summary.trim(),
              description,
              dtstart: start,
              dtend: end,
              start_tz: startTz,
              end_tz: endTz,
              recurrence_semantics: semantics,
              rrule: rrule || null,
            },
          },
        ],
      };
    }
    const saved = await onWrite(request);
    setSaving(false);
    if (saved) onClose();
  };

  const skip = async (): Promise<void> => {
    setSaving(true);
    const saved = await onWrite({
      action: "edit-occurrence",
      input: {
        event_id: event.id,
        original_start: originalStart,
        scope,
        action: "skip",
      },
      optimistic: [
        {
          op: "upsert",
          entity: "schedule.recurrence_exception",
          rowId: `pending:${event.id}:${originalStart}`,
          values: {
            exception_id: `pending:${event.id}:${originalStart}`,
            target_type: "core.event",
            target_id: event.id,
            original_start: originalStart,
            action: "skip",
          },
        },
      ],
    });
    setSaving(false);
    if (saved) onClose();
  };

  const field = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    multiline = false
  ) => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.textSoft }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        autoCapitalize="none"
        style={[
          styles.input,
          multiline && styles.multiline,
          { borderColor: colors.lineStrong, color: colors.text },
        ]}
      />
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
            accessibilityLabel="Close event editor"
            onPress={onClose}
          >
            <Feather name="x" size={23} color={colors.text} />
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Edit event</Text>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void submit()}
          >
            <Text style={[styles.save, { color: colors.accent }]}>
              {saving ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {isRecurring ? (
            <View style={styles.scopeRow}>
              {(["occurrence", "future", "series"] as Scope[]).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: scope === value }}
                  style={[
                    styles.scope,
                    {
                      backgroundColor:
                        scope === value ? colors.text : colors.bgSunken,
                    },
                  ]}
                  onPress={() => setScope(value)}
                >
                  <Text
                    style={[
                      styles.scopeText,
                      { color: scope === value ? colors.bg : colors.textSoft },
                    ]}
                  >
                    {value === "occurrence"
                      ? "This"
                      : value === "future"
                        ? "Future"
                        : "Series"}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {field("Title", summary, setSummary)}
          {field("Description", description, setDescription, true)}
          {field("Start · ISO 8601", start, setStart)}
          {field("End · ISO 8601", end, setEnd)}
          {field("Start timezone", startTz, setStartTz)}
          {field("End timezone", endTz, setEndTz)}
          <Text style={[styles.label, { color: colors.textSoft }]}>
            Time semantics
          </Text>
          <View style={styles.scopeRow}>
            {(["zoned", "floating", "all-day"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: semantics === value }}
                style={[
                  styles.scope,
                  {
                    backgroundColor:
                      semantics === value ? colors.text : colors.bgSunken,
                  },
                ]}
                onPress={() => setSemantics(value)}
              >
                <Text
                  style={[
                    styles.scopeText,
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
          <View style={styles.scopeRow}>
            {calendars.map((calendar) => {
              const id = String(calendar.calendar_id);
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: calendarId === id }}
                  style={[
                    styles.scope,
                    {
                      backgroundColor:
                        calendarId === id ? colors.text : colors.bgSunken,
                    },
                  ]}
                  onPress={() => setCalendarId(id)}
                >
                  <Text
                    style={[
                      styles.scopeText,
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
          {field("Location place ID", location, setLocation)}
          {field("Video call URL", conference, setConference)}
          {field("Reminder minutes", reminders, setReminders)}
          <Text style={[styles.label, { color: colors.textSoft }]}>
            Attendees
          </Text>
          <View style={styles.scopeRow}>
            {partyOptions.map((party) => (
              <Pressable
                key={party.id}
                accessibilityRole="button"
                accessibilityState={{ selected: guestIds.has(party.id) }}
                style={[
                  styles.scope,
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
                    styles.scopeText,
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
          {isRecurring && scope !== "series" ? (
            <Pressable
              accessibilityRole="button"
              style={[styles.skip, { borderColor: colors.danger }]}
              onPress={() => void skip()}
            >
              <Text style={[styles.skipText, { color: colors.danger }]}>
                Skip{" "}
                {scope === "future" ? "this and future" : "this occurrence"}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12, padding: 20, paddingBottom: 60 },
  field: { gap: 5 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 54,
    paddingHorizontal: 18,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  label: {
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  safe: { flex: 1 },
  save: { fontFamily: family.sansBold, fontSize: 14 },
  scope: {
    borderRadius: 999,
    minHeight: 34,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  scopeRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  scopeText: { fontFamily: family.sansMedium, fontSize: 12 },
  skip: {
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  skipText: { fontFamily: family.sansBold, fontSize: 13 },
  title: { fontFamily: family.sansBold, fontSize: 15 },
});
