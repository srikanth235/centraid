import * as Haptics from "expo-haptics";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  HOME_DAY_ONE_DOCS_LABEL,
  HOME_DAY_ONE_PHOTOS_LABEL,
  HOME_DAY_ONE_SEED_LABEL,
  HOME_FIRST_RUN_BODY,
  HOME_FIRST_RUN_TITLE,
  HOME_START_TITLE,
} from "@centraid/client/home-copy";
import { radii } from "@centraid/design";

import AppMark from "../../kit/components/AppMark";
import { Text } from "../../kit/components/NativeText";
import { borders, metrics, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { FirstMove } from "./first-moves";

const MARK = 24;

export interface FirstMovesProps {
  moves: readonly FirstMove[];
  onPick: (move: FirstMove) => void;
}

export default function FirstMovesBand({
  moves,
  onPick,
}: FirstMovesProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (moves.length === 0) return null;
  return (
    <View style={styles.band}>
      <Text style={styles.bandLabel}>{HOME_START_TITLE}</Text>
      {moves.map((move) => (
        <MoveRow
          key={move.id}
          move={move}
          colors={colors}
          styles={styles}
          onPress={() => onPick(move)}
        />
      ))}
    </View>
  );
}

export interface DayOneProps {
  foot: string;
  onSeedSample: () => void;
  onBringPhotos: () => void;
  onBringDocuments: () => void;
}

export function DayOne({
  foot,
  onSeedSample,
  onBringPhotos,
  onBringDocuments,
}: DayOneProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View accessibilityLabel={`Your apps, ${HOME_FIRST_RUN_TITLE}`}>
      <Text style={styles.dayOneTitle}>{HOME_FIRST_RUN_TITLE}</Text>
      {/* Reading register: the only paragraph of prose on Home. */}
      <Text style={styles.dayOneBody}>{HOME_FIRST_RUN_BODY}</Text>
      {/* Wrap row: three content-width choices, not a full-width form. */}
      <View style={styles.dayOneRow}>
        <Pressable
          accessibilityRole="button"
          onPress={onSeedSample}
          style={({ pressed }) => [
            styles.btnPrimary,
            pressed && styles.btnPressed,
          ]}
        >
          <Text style={styles.btnPrimaryLabel}>{HOME_DAY_ONE_SEED_LABEL}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onBringPhotos}
          style={({ pressed }) => [
            styles.btnSecondary,
            pressed && styles.btnPressed,
          ]}
        >
          <Text style={styles.btnSecondaryLabel}>
            {HOME_DAY_ONE_PHOTOS_LABEL}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onBringDocuments}
          style={({ pressed }) => [
            styles.btnSecondary,
            pressed && styles.btnPressed,
          ]}
        >
          <Text style={styles.btnSecondaryLabel}>
            {HOME_DAY_ONE_DOCS_LABEL}
          </Text>
        </Pressable>
      </View>
      <Text style={styles.foot}>{foot}</Text>
    </View>
  );
}

function MoveRow({
  move,
  colors,
  styles,
  onPress,
}: {
  move: FirstMove;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${move.label}. ${move.hint}`}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [styles.move, pressed && styles.movePressed]}
    >
      <AppMark
        color={move.color ?? colors.textSoft}
        iconKey={move.iconKey}
        muted={!move.color}
        size={MARK}
      />
      {/* One 44px row; `move.hint` is a11y-only. */}
      <View style={styles.moveText}>
        <Text numberOfLines={1} style={styles.moveLabel}>
          {move.label}
        </Text>
      </View>
      {/* Decorative; the row label already names the action. */}
      <Text style={styles.arrow} accessibilityElementsHidden>
        →
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    arrow: { ...t("small"), color: colors.textFaint },
    band: {
      borderTopColor: colors.lineStrong,
      borderTopWidth: borders.hairline,
      marginTop: 24,
      paddingTop: 16,
    },
    bandLabel: { ...t("eyebrow"), color: colors.textFaint, marginBottom: 8 },
    btnPressed: { backgroundColor: colors.bgPress },
    btnPrimary: {
      alignItems: "center",
      backgroundColor: colors.text,
      borderRadius: radii.md,
      justifyContent: "center",
      minHeight: metrics.control,
      paddingHorizontal: 16,
    },
    btnPrimaryLabel: { ...t("control"), color: colors.textInv },
    btnSecondary: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: metrics.control,
      paddingHorizontal: 16,
    },
    btnSecondaryLabel: { ...t("control"), color: colors.textSoft },
    dayOneBody: { ...t("reading"), color: colors.textSoft, marginBottom: 24 },
    dayOneRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    dayOneTitle: { ...t("display"), color: colors.text, marginBottom: 12 },
    foot: {
      ...t("mono"),
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      color: colors.textFaint,
      marginTop: 24,
      paddingTop: 12,
    },
    move: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: 12,
      minHeight: metrics.row,
    },
    moveLabel: { ...t("small"), color: colors.text },
    movePressed: { backgroundColor: colors.bgPress },
    moveText: { flex: 1 },
  });
