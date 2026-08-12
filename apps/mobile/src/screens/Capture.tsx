import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import {
  applyDelegateCaptureKind,
  classifyCapture,
} from "@centraid/client/capture";
import type { CaptureKind, CapturePreview } from "@centraid/client/capture";

import Icon from "../kit/components/Icon";
import { Text, TextInput } from "../kit/components/NativeText";
import TopSafeArea from "../kit/components/TopSafeArea";
import { useReplicaQuery } from "../kit/hooks/useReplicaQuery";
import { useReplica } from "../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../kit/replica/write-outcome";
import { family, useTheme } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";
import { authHeader } from "../lib/gateway";
import type { NativeWriteResult } from "../lib/replica/native-session";
import type { CaptureScreenProps } from "../navigation";

const KINDS: CaptureKind[] = ["task", "expense", "note", "event"];

export default function CaptureScreen({
  navigation,
  route,
}: CaptureScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { gatewayBase, session } = useReplica();
  const initial = route.params?.text ?? "";
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState<CapturePreview | undefined>(() =>
    initial ? classifyCapture(initial) : undefined
  );
  const [busy, setBusy] = useState(false);
  const [calendarId, setCalendarId] = useState("");
  const [groupId, setGroupId] = useState("");
  const calendars = useReplicaQuery(
    "agenda",
    useMemo(() => ({ entity: "schedule.calendar" }), [])
  );
  const groups = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "tally.group" }), [])
  );
  const vault = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "core.vault" }), [])
  );

  const classify = async (): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    const local = classifyCapture(text);
    setPreview(local);
    if (local.confidence === "needs-review" && gatewayBase) {
      try {
        const response = await fetch(
          `${gatewayBase}/centraid/_gateway/capture/classify`,
          {
            method: "POST",
            headers: {
              ...authHeader(),
              "content-type": "application/json",
            },
            body: JSON.stringify({ text }),
          }
        );
        if (response.ok) {
          const body = (await response.json()) as { preview?: unknown };
          setPreview(applyDelegateCaptureKind(local, body.preview));
        }
      } catch {
        // The deterministic preview and explicit destination picker remain.
      }
    }
    setBusy(false);
  };

  const save = async (): Promise<void> => {
    if (!preview || !session) return;
    setBusy(true);
    try {
      let result: NativeWriteResult;
      if (preview.kind === "task") {
        result = await session.write("tasks", {
          action: "add",
          input: { title: preview.title, description: preview.body },
        });
      } else if (preview.kind === "note") {
        result = await session.write("notes", {
          action: "create-note",
          input: {
            title: preview.title,
            body_text: preview.body,
            format: "markdown",
          },
        });
      } else if (preview.kind === "event") {
        const selectedCalendar =
          calendarId || String(calendars.rows[0]?.calendar_id ?? "");
        if (!selectedCalendar || !preview.startsAt)
          throw new Error("Choose a calendar and enter an event time.");
        const start = new Date(preview.startsAt);
        result = await session.write("agenda", {
          action: "propose",
          input: {
            summary: preview.title,
            description: preview.body,
            calendar_id: selectedCalendar,
            dtstart: start.toISOString(),
            dtend: new Date(
              start.getTime() + (preview.durationMinutes ?? 60) * 60_000
            ).toISOString(),
          },
        });
      } else {
        const selectedGroup = groupId || String(groups.rows[0]?.group_id ?? "");
        const ownerPartyId = String(vault.rows[0]?.owner_party_id ?? "");
        if (!selectedGroup || !ownerPartyId || !preview.amountMinor)
          throw new Error("Choose a group and enter an amount.");
        result = await session.write("tally", {
          action: "add-expense",
          input: {
            group_id: selectedGroup,
            description: preview.title,
            amount_minor: preview.amountMinor,
            paid_by: ownerPartyId,
            spent_on: new Date().toISOString().slice(0, 10),
            category: "general",
            splits: [
              {
                party_id: ownerPartyId,
                share_minor: preview.amountMinor,
              },
            ],
          },
        });
      }
      if (
        surfaceWriteOutcome(result, {
          onParked: () =>
            navigation.navigate("Settings", { screen: "Approvals" }),
        })
      ) {
        navigation.goBack();
      }
    } catch (error) {
      surfaceWriteFailure(error, "Capture not saved");
    } finally {
      setBusy(false);
    }
  };

  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close quick capture"
          onPress={() => navigation.goBack()}
        >
          <Icon name="x" size={24} color={colors.text} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("Scan")}
          style={[styles.previewButton, { borderColor: colors.lineStrong }]}
        >
          <Text style={[styles.previewText, { color: colors.text }]}>
            Scan with camera
          </Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          Quick capture
        </Text>
        <View style={styles.headerGap} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.help, { color: colors.textSoft }]}>
          Type naturally. Centraid routes obvious captures offline and asks the
          configured local harness only when the destination is ambiguous.
        </Text>
        <TextInput
          autoFocus
          multiline
          value={text}
          onChangeText={(value) => {
            setText(value);
            setPreview(undefined);
          }}
          placeholder="Remind me to call Maya…"
          placeholderTextColor={colors.textFaint}
          style={[
            styles.editor,
            {
              backgroundColor: colors.bgElev,
              borderColor: colors.lineStrong,
              color: colors.text,
            },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!text.trim() || busy}
          onPress={() => void classify()}
          style={[styles.previewButton, { borderColor: colors.lineStrong }]}
        >
          <Text style={[styles.previewText, { color: colors.text }]}>
            {busy && !preview ? "Classifying…" : "Preview"}
          </Text>
        </Pressable>
        {preview ? (
          <>
            <Text style={[styles.review, { color: colors.textSoft }]}>
              Review before saving · {preview.confidence.replace("-", " ")}
            </Text>
            <View style={styles.kindGrid}>
              {KINDS.map((kind) => {
                const active = preview.kind === kind;
                return (
                  <Pressable
                    key={kind}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() =>
                      setPreview({
                        ...preview,
                        kind,
                        confidence: "needs-review",
                      })
                    }
                    style={[
                      styles.kind,
                      {
                        backgroundColor: active
                          ? colors.bgSunken
                          : colors.bgElev,
                        borderColor: active ? colors.accent : colors.line,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.kindText,
                        { color: active ? colors.accent : colors.textSoft },
                      ]}
                    >
                      {kind}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Field
              label="Title"
              value={preview.title}
              onChangeText={(title) => setPreview({ ...preview, title })}
              colors={colors}
            />
            {preview.kind === "event" ? (
              <>
                <Field
                  label="Starts (ISO or local date)"
                  value={preview.startsAt ?? ""}
                  onChangeText={(startsAt) =>
                    setPreview(
                      startsAt
                        ? { ...preview, startsAt }
                        : withoutStartsAt(preview)
                    )
                  }
                  colors={colors}
                />
                <ChoiceRows
                  label="Calendar"
                  rows={calendars.rows.map((row) => ({
                    id: String(row.calendar_id),
                    label: String(row.name ?? "Calendar"),
                  }))}
                  selected={calendarId}
                  onSelect={setCalendarId}
                  colors={colors}
                />
              </>
            ) : null}
            {preview.kind === "expense" ? (
              <>
                <Field
                  label="Amount"
                  keyboardType="decimal-pad"
                  value={
                    preview.amountMinor
                      ? (preview.amountMinor / 100).toFixed(2)
                      : ""
                  }
                  onChangeText={(amount) =>
                    setPreview({
                      ...preview,
                      amountMinor: Math.round(Number(amount || 0) * 100),
                    })
                  }
                  colors={colors}
                />
                <ChoiceRows
                  label="Group"
                  rows={groups.rows.map((row) => ({
                    id: String(row.group_id),
                    label: String(row.name ?? "Expense group"),
                  }))}
                  selected={groupId}
                  onSelect={setGroupId}
                  colors={colors}
                />
              </>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={busy || !session}
              onPress={() => void save()}
              style={[styles.save, { backgroundColor: colors.accent }]}
            >
              <Text style={[styles.saveText, { color: colors.textInv }]}>
                {busy ? "Saving…" : `Save ${preview.kind}`}
              </Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </TopSafeArea>
  );
}

function Field({
  label,
  colors,
  ...input
}: React.ComponentProps<typeof TextInput> & {
  label: string;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.textSoft }]}>
        {label}
      </Text>
      <TextInput
        {...input}
        placeholderTextColor={colors.textFaint}
        style={[
          styles.input,
          {
            backgroundColor: colors.bgElev,
            borderColor: colors.lineStrong,
            color: colors.text,
          },
        ]}
      />
    </View>
  );
}

function ChoiceRows({
  label,
  rows,
  selected,
  onSelect,
  colors,
}: {
  label: string;
  rows: Array<{ id: string; label: string }>;
  selected: string;
  onSelect: (id: string) => void;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.textSoft }]}>
        {label}
      </Text>
      <View style={styles.choices}>
        {rows.map((row, index) => {
          const active = (selected || rows[0]?.id) === row.id;
          return (
            <Pressable
              key={row.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(row.id)}
              style={[
                styles.choice,
                {
                  borderColor: active ? colors.accent : colors.line,
                  backgroundColor: active ? colors.bgSunken : colors.bgElev,
                },
              ]}
            >
              <Text style={{ color: colors.text }}>
                {row.label || `${label} ${index + 1}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function withoutStartsAt(preview: CapturePreview): CapturePreview {
  const { startsAt: _startsAt, ...rest } = preview;
  return rest;
}

const styles = StyleSheet.create({
  choice: { borderRadius: 10, borderWidth: 1, padding: 11 },
  choices: { gap: 8 },
  content: { gap: 14, padding: 20, paddingBottom: 60 },
  editor: {
    borderRadius: 14,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 16,
    minHeight: 120,
    padding: 14,
    textAlignVertical: "top",
  },
  field: { gap: 7 },
  fieldLabel: { fontFamily: family.sansMedium, fontSize: 12 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 56,
    paddingHorizontal: 18,
  },
  headerGap: { width: 24 },
  help: { fontFamily: family.sansRegular, fontSize: 14, lineHeight: 20 },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 15,
    padding: 12,
  },
  kind: {
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  kindGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  kindText: {
    fontFamily: family.sansMedium,
    fontSize: 12,
    textTransform: "capitalize",
  },
  previewButton: {
    alignItems: "center",
    borderRadius: 11,
    borderWidth: 1,
    padding: 12,
  },
  previewText: { fontFamily: family.sansMedium, fontSize: 14 },
  review: { fontFamily: family.monoMedium, fontSize: 11 },
  safe: { flex: 1 },
  save: { alignItems: "center", borderRadius: 12, marginTop: 6, padding: 14 },
  saveText: { fontFamily: family.sansMedium, fontSize: 15 },
  title: {
    flex: 1,
    fontFamily: family.sansMedium,
    fontSize: 21,
    textAlign: "center",
  },
});
