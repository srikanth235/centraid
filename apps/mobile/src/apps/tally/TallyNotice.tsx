// THE ONE NOTICE ROW, and the states it can carry (STATES.md's Tally row).
//
// Every list-bearing surface asks `tallyScreenState` once and hands the answer
// here, so a dozen surfaces cannot disagree about what "offline" looks like.
// NO TOAST, NO SPINNER, NO BADGE, NO RED DOT — a notice is a bordered row with
// a sentence, and an outcome goes to the frame's one status line.
//
// LOADING IS NOT A NOTICE. It is skeleton rows at the list's own geometry,
// which is the caller's job, because a notice saying "still reading" tells a
// member nothing they cannot see. Neither is ALL SETTLED: it is a state of the
// figures, drawn by the hero in its own words (§6), not a warning about a delay.
//
// The `--net` token is spent on exactly one state: denied. Offline, stale,
// pending, parked and conflict are facts about a delay, not about a refusal —
// and the offline one is the least alarming of the five, because Tally records
// fully offline and the notice's whole job is to name the one exception.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import {
  CONFLICT_NOTICE,
  OFFLINE_NOTICE,
  PARKED_NOTICE,
  pendingNotice,
  staleNotice,
} from "@centraid/blueprints/apps/tally/view-copy";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { clockAt } from "./tally-view-model";
import type { TallyScreenState } from "./tally-view-model";

export interface TallyNoticeProps {
  state: TallyScreenState;
  /** How many of this member's writes are still on this device. */
  pending: number;
  /** When the last read landed, for the stale sentence's clock. */
  lastReadAt: string | null;
}

/** The sentence one state carries, or nothing where the state is not a notice
 *  (`ready`, `dayone`, `settled`, `denied` and `loading` are screens). */
export function tallyNoticeText(props: TallyNoticeProps): string | null {
  if (props.state === "conflict") return CONFLICT_NOTICE;
  if (props.state === "parked") return PARKED_NOTICE;
  if (props.state === "offline") return OFFLINE_NOTICE;
  if (props.state === "pending") return pendingNotice(props.pending);
  if (props.state === "stale") {
    const at = props.lastReadAt ? clockAt(props.lastReadAt) : null;
    return at === null ? null : staleNotice(at);
  }
  return null;
}

export default function TallyNotice(
  props: TallyNoticeProps
): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const text = tallyNoticeText(props);
  if (!text) return null;
  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    notice: {
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      gap: spacing[2],
      marginHorizontal: spacing[4],
      marginTop: spacing[3],
      padding: spacing[3],
    },
    text: { ...t("small"), color: colors.text },
  });
