import React, { useMemo, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { borders, radii, t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import { Text } from "./NativeText";
import { readStatus, subscribeStatus } from "./status-line";

/** Counts are numerics, so they are mono and tabular — and grouped, because
 *  "1904" and "1,904" are not equally readable at 11.5px. Mirrors
 *  `packages/client/src/react/shell/StatusLine.tsx`'s `count()`. */
const count = (n: number): string => n.toLocaleString();

/**
 * The app's one persistent status line (issue 707, invariant 5) — the
 * native counterpart of the shell's `StatusLine.tsx`. Replaces `ToastHost`.
 *
 * Unlike the shell, mobile has no per-route "ambient sentence" yet (that is
 * chrome the desktop/PWA nav bar owns and the springboard model doesn't have
 * an equivalent surface for); this host is quiet — renders nothing — until a
 * caller posts a note, then updates THAT SAME line in place rather than
 * stacking a new element per message, and goes quiet again when the note is
 * cleared or times out. That is the whole toast→status-line contract: one
 * mounted host, reused, never a spinner.
 */
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
        style={[styles.host, { paddingBottom: Math.max(insets.bottom, 10) }]}
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
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      bottom: 0,
      flexDirection: "row",
      left: 0,
      minHeight: 32,
      paddingHorizontal: 14,
      paddingTop: 8,
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
