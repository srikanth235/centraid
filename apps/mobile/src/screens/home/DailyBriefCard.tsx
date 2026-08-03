import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { family, radii, useTheme } from "../../kit/theme";
import type { DailyBrief } from "../../lib/daily-brief";

export default function DailyBriefCard({
  brief,
  onEvents,
  onTasks,
  onPhotos,
  onTally,
}: {
  brief?: DailyBrief;
  onEvents: () => void;
  onTasks: () => void;
  onPhotos: () => void;
  onTally: () => void;
}): React.JSX.Element | null {
  const { colors } = useTheme();
  if (!brief) return null;
  const balance = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: brief.currency,
  }).format(brief.balanceMinor / 100);
  const cells = [
    {
      key: "events",
      value: String(brief.events.length),
      label: "events",
      handlePress: onEvents,
    },
    {
      key: "tasks",
      value: String(brief.tasks.length),
      label: "due tasks",
      handlePress: onTasks,
    },
    {
      key: "photos",
      value: String(brief.newPhotos),
      label: "new photos",
      handlePress: onPhotos,
    },
    {
      key: "balance",
      value: balance,
      label: brief.balanceMinor >= 0 ? "you are owed" : "you owe",
      handlePress: onTally,
    },
  ];
  return (
    <View
      accessibilityLabel="Daily brief"
      style={[
        styles.card,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
    >
      <Text style={[styles.eyebrow, { color: colors.accent }]}>
        TODAY’S BRIEF
      </Text>
      <View style={styles.grid}>
        {cells.map((cell) => (
          <Pressable
            accessibilityLabel={`${cell.value} ${cell.label}`}
            accessibilityRole="button"
            key={cell.key}
            onPress={cell.handlePress}
            style={styles.cell}
          >
            <Text style={[styles.value, { color: colors.text }]}>
              {cell.value}
            </Text>
            <Text style={[styles.label, { color: colors.textSoft }]}>
              {cell.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {[...brief.events.slice(0, 2), ...brief.tasks.slice(0, 2)].length ? (
        <Text
          numberOfLines={2}
          style={[styles.timeline, { color: colors.textSoft }]}
        >
          {[...brief.events.slice(0, 2), ...brief.tasks.slice(0, 2)]
            .map((item) => item.title)
            .join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
    marginBottom: 18,
    padding: 16,
  },
  eyebrow: { fontFamily: family.monoMedium, fontSize: 10, letterSpacing: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { paddingVertical: 5, width: "50%" },
  value: { fontFamily: family.sansMedium, fontSize: 19 },
  label: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 1 },
  timeline: { fontFamily: family.sansRegular, fontSize: 12, lineHeight: 18 },
});
