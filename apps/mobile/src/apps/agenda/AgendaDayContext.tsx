// The day-context layers as the phone draws them (#834): the ribbon on a day
// header, the collapsed due-task shelf under it, and the one notification day
// context earns.
//
// NEITHER IS A ROW. A birthday and a due date have no time cost, so neither
// gets a card beside a meeting — the ribbon is an annotation on a 2pt rule and
// the shelf is one line that opens on tap. Tap-through leaves for Tasks, the
// room that owns the task; Agenda shows the fact and never edits it.
import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import type { ThemeColors } from "../../kit/theme";
import { scheduleBirthdayNotifications } from "../../lib/notifications-core";
import { styles } from "./AgendaHome.styles";
import { ribbonLabel, shelfLabel } from "./day-context";
import type { ContextRow, DueRow, RibbonFact } from "./day-context";

/** A day's costless facts, on one line. Several collapse into a count rather
 *  than pushing the day's events off the top of the screen. */
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

/**
 * One day's due-task shelf. Collapsed to `3 due` until the member asks for the
 * names — a due date has no time cost, so it never gets a card of its own
 * beside a meeting.
 */
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

/**
 * THE ONE NOTIFICATION DAY CONTEXT EARNS. Scheduled from the surface that
 * already holds the people and the starred set, so no second read is made, and
 * idempotent through the device's own scheduled-key ledger — a re-entry into
 * Agenda never doubles a banner.
 *
 * Never for anyone the owner has not starred: `planBirthdayNotifications`
 * makes that its first line, and everyone else stays a ribbon on the day.
 */
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
