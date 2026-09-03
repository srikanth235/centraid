import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import type { ThemeColors } from "../../kit/theme";
import { scheduleBirthdayNotifications } from "../../lib/notifications-core";
import { styles } from "./AgendaHome.styles";
import { ribbonLabel, shelfLabel } from "./day-context";
import type { ContextRow, DueRow, RibbonFact } from "./day-context";

export function DayRibbon({
  facts,
  colors,
}: {
  facts: readonly RibbonFact[];
  colors: ThemeColors;
}): React.JSX.Element | null {
  if (facts.length === 0) return null;
  return (
    <Text
      style={[
        styles.ribbon,
        { borderStartColor: colors.line, color: colors.textSoft },
      ]}
      numberOfLines={1}
    >
      {ribbonLabel(facts)}
    </Text>
  );
}

export default function AgendaDayContext({
  due,
  colors,
  onOpenTask,
}: {
  due: readonly DueRow[];
  colors: ThemeColors;
  onOpenTask: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.shelfToggle}
      >
        <Text style={[styles.shelfText, { color: colors.textSoft }]}>
          {open ? "Hide" : shelfLabel(due.length)}
        </Text>
      </Pressable>
      {open
        ? due.map((row) => (
            <Pressable
              key={row.taskId}
              accessibilityRole="button"
              accessibilityLabel={`${row.title}, open in Tasks`}
              onPress={onOpenTask}
              style={[styles.shelfRow, { borderStartColor: colors.line }]}
            >
              <Text
                style={[styles.shelfText, { color: colors.textSoft }]}
                numberOfLines={1}
              >
                {row.title}
              </Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

export function useBirthdayNotifications(
  parties: readonly ContextRow[],
  starred: ReadonlySet<string>,
  leadDays: number
): void {
  useEffect(() => {
    if (parties.length === 0) return;
    const people = parties.flatMap((party) => {
      const partyId = String(party["party_id"] ?? "");
      const birthDate = String(party["birth_date"] ?? "");
      const name = String(party["display_name"] ?? "");
      if (!partyId || !birthDate || !name) return [];
      return [{ birthDate, inner: starred.has(partyId), name, partyId }];
    });
    void scheduleBirthdayNotifications(people, leadDays).catch(() => undefined);
  }, [leadDays, parties, starred]);
}
