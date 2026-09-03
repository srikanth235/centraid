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
  pending: number;
  lastReadAt: string | null;
}

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
