import React, { useMemo, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BAND_HEIGHT } from "../band-surface";
import { borders, radii, t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import { Text } from "./NativeText";
import { readStatus, subscribeStatus } from "./status-line";

const count = (n: number): string => n.toLocaleString();

export default function StatusLine(): React.JSX.Element | null {
  const note = useSyncExternalStore(subscribeStatus, readStatus, readStatus);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  if (!note) return null;

  const handleAction = note.action?.run;
  const progress = note.progress;
  const pct =
    progress && progress.total > 0
      ? Math.max(0, Math.min(1, progress.done / progress.total))
      : 0;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View
        accessibilityLiveRegion="polite"
        accessibilityRole="text"
        style={[styles.host, { bottom: BAND_HEIGHT + insets.bottom }]}
      >
        <View style={[styles.dot, { backgroundColor: colors.textFaint }]} />
        <Text style={styles.text} numberOfLines={1}>
          {note.text}
        </Text>
        {progress ? (
          <>
            {/* Determinate, always — a local operation knows its own size,
                and a spinner would be the one thing this product can never
                honestly say: "I don't know how long". */}
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  { backgroundColor: colors.text, width: `${pct * 100}%` },
                ]}
              />
            </View>
            <Text style={styles.counts}>
              {count(progress.done)} of {count(progress.total)}
              {progress.unit ? ` ${progress.unit}` : ""}
            </Text>
          </>
        ) : null}
        {note.action ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={handleAction}
            style={styles.action}
          >
            <Text style={styles.actionText}>{note.action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: { marginLeft: 8, minHeight: 32, justifyContent: "center" },
    actionText: {
      ...t("control"),
      color: colors.text,
    },
    counts: {
      ...t("mono"),
      color: colors.textSoft,
      marginLeft: 8,
    },
    dot: { borderRadius: radii.sm, height: 6, marginRight: 8, width: 6 },
    fill: { borderRadius: radii.pill, height: 3 },
    host: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      left: 0,
      minHeight: 32,
      paddingHorizontal: 14,
      paddingVertical: 8,
      position: "absolute",
      right: 0,
    },
    text: {
      ...t("small"),
      color: colors.text,
      flexShrink: 1,
    },
    track: {
      backgroundColor: colors.line,
      borderRadius: radii.pill,
      height: 3,
      marginLeft: 8,
      overflow: "hidden",
      width: 40,
    },
  });
