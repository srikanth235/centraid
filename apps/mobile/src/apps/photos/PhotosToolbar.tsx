// The Photos toolbar row (handoff §3.1) — and it renders only when it carries
// something, because an empty band is chrome.
//
// On the phone it carries the tile-size stepper. The stepper is the POINTER
// equivalent of the pinch gesture on the grid (§4.2): both move the same
// member preference by one rung, so nothing here is reachable by gesture
// alone. All four rungs are offered — dropping rungs on the phone would make a
// member preference surface-specific.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { RUNGS, RUNG_LABELS, stepRung } from "./photos-rungs";
import type { Rung } from "./photos-rungs";

export interface PhotosToolbarProps {
  rung: Rung;
  onRungChange: (next: Rung) => void;
  /** The library's size, stated exactly — progress and counts are never a
   *  spinner or a badge in this product. */
  total: number;
}

export default function PhotosToolbar({
  rung,
  onRungChange,
  total,
}: PhotosToolbarProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const smallest = rung === 0;
  const largest = rung === RUNGS.length - 1;
  return (
    <View style={styles.bar}>
      <Text style={styles.count} numberOfLines={1}>
        {total} {total === 1 ? "photograph" : "photographs"}
      </Text>
      <View style={styles.stepper}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Smaller tiles"
          accessibilityState={{ disabled: smallest }}
          disabled={smallest}
          onPress={() => onRungChange(stepRung(rung, -1))}
          style={styles.step}
        >
          <Icon
            name="chevron-left"
            size={18}
            // A disabled control takes its own token on the leaf; the group
            // never expresses state with a container opacity (§18).
            color={smallest ? colors.textDisabled : colors.text}
          />
        </Pressable>
        <Text style={styles.rung} numberOfLines={1}>
          {RUNG_LABELS[rung]}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Larger tiles"
          accessibilityState={{ disabled: largest }}
          disabled={largest}
          onPress={() => onRungChange(stepRung(rung, 1))}
          style={styles.step}
        >
          <Icon
            name="chevron-right"
            size={18}
            color={largest ? colors.textDisabled : colors.text}
          />
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 44,
      paddingHorizontal: pageMargin,
    },
    count: { ...t("mono"), color: colors.textSoft },
    rung: {
      ...t("mono"),
      color: colors.text,
      minWidth: 22,
      textAlign: "center",
    },
    step: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    stepper: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: 12,
      borderWidth: borders.hairline,
      flexDirection: "row",
    },
  });
