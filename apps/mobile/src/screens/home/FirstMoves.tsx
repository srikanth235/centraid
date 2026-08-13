// The two renderings of "this app has nothing in it yet" (the Binding Layer,
// Home — graded, not binary).
//
// Two weights, and the difference between them is the whole grading idea:
//
//  · `DayOne` — nothing anywhere. A THEMED PAGE: display title, one paragraph
//    in the reading register, a wrap row of three buttons (one filled — the
//    vault's own sample offer — flanked by two outlined "bring in your own"
//    moves), a mono foot carrying real counts. It is allowed to be a page
//    because there is nothing else on the screen.
//  · `FirstMovesBand` — at least one app has content, drawn from the shared
//    first-moves catalog (./first-moves). A hairline rule, a micro-caps
//    label, up to three 44px rows with a trailing arrow. No serif, no
//    paragraph: the page above it is already working, and a nudge as loud as
//    the thing it is nudging you away from stops being a nudge.
//
// Day one's three buttons are their OWN fixed trio (handoff :979–990), not a
// slice of the catalog `FirstMovesBand` draws from: the band's rows are a
// general nudge across up to nine apps and their labels come from
// `HOME_FIRST_MOVE_COPY`, but day one is a themed page with exactly three
// offers whose copy is the page's own (`HOME_DAY_ONE_*` in
// @centraid/client/home-copy).
//
// What is NOT here, deliberately: dashed placeholder cards. A dashed rectangle
// per empty app was the old day-one treatment, and it had two faults the brief
// names — it scaled to eight identical apologies as the vault filled, and each
// one opened the empty app it was named after, which is a dead end wearing an
// invitation. Every move below lands somewhere that can TAKE content.

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
import { iconChipFinish, iconChipRadius, radii } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, metrics, t, useTheme } from "../../kit/theme";
import type { Scheme, ThemeColors } from "../../kit/theme";
import type { FirstMove } from "./first-moves";

const MARK = 24;

export interface FirstMovesProps {
  moves: readonly FirstMove[];
  onPick: (move: FirstMove) => void;
}

/**
 * The quiet band under a populated grid.
 *
 * `HOME_START_TITLE` is set in the micro-caps role, which is the system's label
 * register — it is a heading for a strip, not a heading for a page, and the
 * ramp has exactly one way to say that.
 */
export default function FirstMovesBand({
  moves,
  onPick,
}: FirstMovesProps): React.JSX.Element | null {
  const { colors, scheme } = useTheme();
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
          scheme={scheme}
          styles={styles}
          onPress={() => onPick(move)}
        />
      ))}
    </View>
  );
}

export interface DayOneProps {
  /** The mono foot. Real counts only — see `HomeStatusLine` for the same rule. */
  foot: string;
  /** The one filled offer — the vault's own sample week. */
  onSeedSample: () => void;
  /** The two outlined "bring in your own" moves the body paragraph promises. */
  onBringPhotos: () => void;
  onBringDocuments: () => void;
}

/**
 * Day one: the vault holds nothing anywhere.
 *
 * Reached only when every readable tile has SETTLED and is empty
 * (./tile-model#springboardState). A vault that is merely still loading, or
 * whose replica is unreachable, gets the ordinary grid instead — this page is a
 * claim about the vault, and an unanswered read has not earned the right to
 * make it.
 */
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
      {/* The reading register, serif. This is the one paragraph of prose on
          Home, and the second register exists so prose does not look like UI
          text — least of all on the screen where a member is deciding whether
          any of this is worth their archive. */}
      <Text style={styles.dayOneBody}>{HOME_FIRST_RUN_BODY}</Text>
      {/* handoff :978–991, `frRowStyle` — a WRAP row, not a stack of full-width
          rows: three buttons at their own content width read as three
          choices; three rows the width of the page would read as a form. */}
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
  scheme,
  styles,
  onPress,
}: {
  move: FirstMove;
  colors: ThemeColors;
  scheme: Scheme;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  const finish = move.color
    ? iconChipFinish(move.color, colors.bg, scheme)
    : undefined;
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
      <View
        style={[
          styles.mark,
          finish
            ? {
                backgroundColor: finish.backgroundColor,
                borderRadius: iconChipRadius(MARK),
              }
            : undefined,
        ]}
      >
        <Icon
          name={move.iconKey}
          size={14}
          color={finish ? finish.markColor : colors.textSoft}
        />
      </View>
      {/* handoff :1211–1237 — one 44px row is chip + label + arrow, no second
          line. `move.hint` still carries the accessibility label above; a
          sighted member gets the label alone, the same information a
          screen-reader user gets read in full. */}
      <View style={styles.moveText}>
        <Text numberOfLines={1} style={styles.moveLabel}>
          {move.label}
        </Text>
      </View>
      {/* Where a control must read as an action without a hover state to lean
          on, it carries a trailing arrow. Decorative — the row's own label
          already says what it does. */}
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
      // `movesWrapStyle`, :5706 — `t.line`, the stronger rung (`lineStrong`
      // here), not the hairline `t.lineS` each row below draws.
      borderTopColor: colors.lineStrong,
      borderTopWidth: borders.hairline,
      // `movesWrapStyle`, :5706 — `R.gap.xl` (24).
      marginTop: 24,
      paddingTop: 16,
    },
    // `movesLabelStyle`, :5707 — margin-bottom 8.
    bandLabel: { ...t("eyebrow"), color: colors.textFaint, marginBottom: 8 },
    // btnBase, handoff :5103 — height `metrics.control` (34, R.ctl), radius
    // `radii.md` (7, R.rad.ctl), the `control` type role (500 13px sans).
    btnPressed: { backgroundColor: colors.bgPress },
    btnPrimary: {
      alignItems: "center",
      backgroundColor: colors.text,
      borderRadius: radii.md,
      justifyContent: "center",
      minHeight: metrics.control,
      paddingHorizontal: 16,
    },
    // The solved inverse foreground on the theme's ink fill.
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
    // frRowStyle, handoff :5704 — a WRAP row of the three buttons above.
    dayOneRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    // frTitleStyle margin-bottom, handoff :5699 — R.gap.m (12).
    dayOneTitle: { ...t("display"), color: colors.text, marginBottom: 12 },
    foot: {
      ...t("mono"),
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      color: colors.textFaint,
      // Day-one foot, handoff :5734 area — `R.gap.xl` (24).
      marginTop: 24,
      paddingTop: 12,
    },
    mark: {
      alignItems: "center",
      height: MARK,
      justifyContent: "center",
      width: MARK,
    },
    move: {
      alignItems: "center",
      // Each move row draws its own rule, :5719-5720 — `t.lineS` (the
      // hairline `line` rung, not the band's own stronger one above).
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
