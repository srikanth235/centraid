import React from "react";
import { Pressable, ScrollView, View } from "react-native";

import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";
import { describeRecurrence, expandRecurrence } from "@centraid/time-engine";

import { Text } from "../../kit/components/NativeText";
import type { ThemeColors } from "../../kit/theme";
import { styles } from "./TallyHome.styles";

type EditScope = "occurrence" | "future" | "series";
type Write = (
  action: string,
  input: Record<string, ReplicaValue>
) => Promise<unknown>;

interface TallyRecurringTemplatesProps {
  templates: ReplicaRow[];
  exceptions: ReplicaRow[];
  colors: ThemeColors;
  onWrite: Write;
  onBeginEdit: (
    template: ReplicaRow,
    originalStart: string,
    scope: EditScope
  ) => void;
}

const asString = (value: unknown): string =>
  value == null ? "" : String(value);

function upcomingStarts(
  template: ReplicaRow,
  exceptions: ReplicaRow[]
): string[] {
  if (template.status !== "active") return [];
  const from = new Date();
  const rows = expandRecurrence({
    rrule: asString(template.rrule),
    start: asString(template.anchor_start),
    rangeFrom: from.toISOString(),
    rangeTo: new Date(from.getTime() + 370 * 86_400_000).toISOString(),
    timeZone: asString(template.time_zone) || "UTC",
    maxInstances: 8,
  });
  const exceptionRows = exceptions.filter(
    (row) => row.target_id === template.template_id
  );
  return rows
    .filter(
      (row) =>
        !exceptionRows.some(
          (exception) =>
            exception.action === "skip" &&
            exception.original_start === row.originalStart
        )
    )
    .slice(0, 3)
    .map((row) => row.originalStart);
}

export default function TallyRecurringTemplates({
  templates,
  exceptions,
  colors,
  onWrite,
  onBeginEdit,
}: TallyRecurringTemplatesProps): React.JSX.Element | null {
  if (templates.length === 0) return null;
  return (
    <ScrollView horizontal contentContainerStyle={styles.templates}>
      {templates.map((template) => {
        const upcoming = upcomingStarts(template, exceptions);
        const next = upcoming[0];
        return (
          <View
            key={asString(template.template_id)}
            style={[
              styles.template,
              { backgroundColor: colors.bgElev, borderColor: colors.line },
            ]}
          >
            <Text style={[styles.personName, { color: colors.text }]}>
              {asString(template.description)}
            </Text>
            <Text style={[styles.meta, { color: colors.textFaint }]}>
              {describeRecurrence(asString(template.rrule)) ??
                asString(template.rrule)}{" "}
              · {asString(template.original_currency)}
            </Text>
            <Text style={[styles.meta, { color: colors.textFaint }]}>
              {upcoming.length
                ? upcoming
                    .map((start) => new Date(start).toLocaleDateString())
                    .join(" · ")
                : asString(template.status)}
            </Text>
            <View style={styles.row}>
              <Pressable
                disabled={!next}
                accessibilityLabel={`Record ${asString(template.description)}`}
                accessibilityRole="button"
                onPress={() =>
                  next &&
                  void onWrite("materialize-recurring-expense", {
                    template_id: asString(template.template_id),
                    original_start: next,
                  })
                }
              >
                <Text style={{ color: colors.accent }}>Record</Text>
              </Pressable>
              <Pressable
                disabled={!next}
                accessibilityLabel={`Skip ${asString(template.description)}`}
                accessibilityRole="button"
                onPress={() =>
                  next &&
                  void onWrite("edit-recurring-expense-occurrence", {
                    template_id: asString(template.template_id),
                    original_start: next,
                    scope: "occurrence",
                    action: "skip",
                  })
                }
              >
                <Text style={{ color: colors.danger }}>Skip</Text>
              </Pressable>
              <Pressable
                disabled={!next}
                accessibilityLabel={`Edit this ${asString(template.description)}`}
                accessibilityRole="button"
                onPress={() =>
                  next && onBeginEdit(template, next, "occurrence")
                }
              >
                <Text style={{ color: colors.accent }}>Edit this</Text>
              </Pressable>
              <Pressable
                disabled={!next}
                accessibilityLabel={`Edit future ${asString(template.description)}`}
                accessibilityRole="button"
                onPress={() => next && onBeginEdit(template, next, "future")}
              >
                <Text style={{ color: colors.accent }}>Edit future</Text>
              </Pressable>
              <Pressable
                disabled={!next}
                accessibilityLabel={`Edit series ${asString(template.description)}`}
                accessibilityRole="button"
                onPress={() => next && onBeginEdit(template, next, "series")}
              >
                <Text style={{ color: colors.accent }}>Edit series</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={`End ${asString(template.description)}`}
                accessibilityRole="button"
                onPress={() =>
                  void onWrite("edit-recurring-expense-occurrence", {
                    template_id: asString(template.template_id),
                    original_start: next ?? new Date().toISOString(),
                    scope: "series",
                    action: "skip",
                  })
                }
              >
                <Text style={{ color: colors.danger }}>End</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
