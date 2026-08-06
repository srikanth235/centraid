// Home's title row: the route's name, and the two things you can do from it.
//
// "Home" is set in the TITLE role (appNameStyle, handoff :5536 — 500 20px/26px
// sans), not the display serif. The display face is reserved for a route's own
// content register — the day-one headline below it, a document's own title —
// and Home's own name is chrome, the same weight class the app bar draws every
// other route's name in.
//
// The two controls beside it are the view's primacy statement, and there is
// exactly one of them: **Search everything** is the single FILLED ink element
// on Home (invariant 3 — primacy is carried by fill-versus-outline alone, never
// by a hue), and **All apps** is outlined beside it. That ordering is an
// argument: on a screen made of previews, the thing you most often want is the
// object you are thinking of, not the app that happens to hold it.
//
// Both are bounded controls rather than bare text. Hover is nothing on a phone,
// so a word that acts has to look like a control before it is touched.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { HOME_SEARCH_EVERYTHING } from "@centraid/client/home-copy";
import { radii } from "@centraid/design";

import { Text } from "../../kit/components/NativeText";
import { borders, metrics, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const HOME_TITLE = "Home";
export const ALL_APPS_LABEL = "All apps";

export interface HomeTitleRowProps {
  onAllApps: () => void;
  onSearch: () => void;
}

export default function HomeTitleRow({
  onAllApps,
  onSearch,
}: HomeTitleRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{HOME_TITLE}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ALL_APPS_LABEL}
        onPress={onAllApps}
        style={({ pressed }) => [styles.outlined, pressed && styles.dim]}
      >
        <Text style={styles.outlinedLabel}>{ALL_APPS_LABEL}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={HOME_SEARCH_EVERYTHING}
        onPress={onSearch}
        style={({ pressed }) => [styles.filled, pressed && styles.dim]}
      >
        <Text style={styles.filledLabel}>{HOME_SEARCH_EVERYTHING}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // A press state on the leaf, not a container opacity: both controls are a
    // single text leaf on a single ground, so the ground is what moves.
    dim: { backgroundColor: colors.bgPress },
    // The one filled ink element on this view. Ink, never a hue — if the shell
    // spends no colour, every colour on Home belongs to an app.
    filled: {
      alignItems: "center",
      backgroundColor: colors.text,
      borderRadius: radii.md,
      justifyContent: "center",
      minHeight: metrics.control,
      paddingHorizontal: 24,
    },
    // The page colour on ink, not white — `--text-inv` is the paper.
    filledLabel: { ...t("control"), color: colors.onAccent },
    outlined: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: metrics.control,
      paddingHorizontal: 24,
    },
    outlinedLabel: { ...t("control"), color: colors.text },
    // Fixed chrome now (moved out of the ScrollView, see Home.tsx), so this
    // row owns its own horizontal margin and the rule the handoff's app bar
    // draws beneath it (`appBarStyle`, :5532–5533) — the same rule the
    // prototype's scroll region starts flush under.
    row: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      paddingBottom: 14,
      paddingHorizontal: pageMargin,
    },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
