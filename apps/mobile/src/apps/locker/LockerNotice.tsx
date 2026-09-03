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
  pending: number;
  waiting?: string | null;
  lastReadAt: string | null;
}

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
