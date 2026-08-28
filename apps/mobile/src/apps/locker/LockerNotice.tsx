// THE ONE NOTICE ROW, and the seven-plus-two states it can carry
// (STATES.md's Locker row; README-Locker §4).
//
// Every list-bearing surface asks `lockerScreenState` once and hands the
// answer here, so nine surfaces cannot disagree about what "offline" looks
// like. NO TOAST, NO SPINNER, NO BADGE, NO RED DOT — a notice is a bordered
// row with a sentence, and an outcome goes to the frame's one status line.
//
// LOADING IS NOT A NOTICE. It is skeleton rows at the list's own geometry,
// which is `SkeletonRows` and the caller's job, because a notice saying "still
// reading" tells a member nothing they cannot see.
//
// The `--net` border is spent on exactly one state: denied. Offline, stale,
// pending, parked and conflict are facts about a delay, not about a refusal.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { clockAt } from "@centraid/blueprints/apps/locker/format";
import {
  CONFLICT_NOTICE,
  OFFLINE_NOTICE,
  OFFLINE_WHY_BODY,
  PARKED_NOTICE,
  REAUTH_NOTICE,
  pendingNotice,
  staleNotice,
} from "@centraid/blueprints/apps/locker/view-copy";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { LockerScreenState } from "./locker-view-model";

export interface LockerNoticeProps {
  state: LockerScreenState;
  /** How many metadata writes are still on this device. Never a secret. */
  pending: number;
  waiting?: string | null;
  /** When the window last landed, for the stale sentence's clock. */
  lastReadAt: string | null;
}

/** The sentence one state carries, or nothing where the state is not a notice
 *  (`ready`, `dayone`, `denied` and `loading` are screens, not rows). */
export function lockerNoticeText(props: LockerNoticeProps): string | null {
  if (props.state === "offline") return OFFLINE_NOTICE;
  if (props.state === "pending")
    return props.waiting ?? pendingNotice(props.pending);
  if (props.state === "stale") {
    return props.lastReadAt ? staleNotice(clockAt(props.lastReadAt)) : null;
  }
  if (props.state === "conflict") return CONFLICT_NOTICE;
  if (props.state === "parked") return props.waiting ?? PARKED_NOTICE;
  if (props.state === "reauth") return REAUTH_NOTICE;
  return null;
}

export default function LockerNotice(
  props: LockerNoticeProps
): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const text = lockerNoticeText(props);
  if (!text) return null;
  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.text}>{text}</Text>
      {/* Offline names what still works AND why a secret does not — the rule,
          not a limitation (STATES.md, Locker / Offline). */}
      {props.state === "offline" ? (
        <Text style={styles.why}>{OFFLINE_WHY_BODY}</Text>
      ) : null}
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
    why: { ...t("mono"), color: colors.textFaint },
  });
