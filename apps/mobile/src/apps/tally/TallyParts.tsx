// THE COMPONENT RECIPES (Tally spec §5), drawn once for every list in the app.
//
// Four leaves and one rule. The rule is the app's one SIGN CONVENTION:
// positive is owed to you, negative is owed by you, so a figure never needs a
// legend. That convention is expressed exactly once — `format.figureTone` —
// and `Figure` below is the only leaf that reads it. `--net` means you owe,
// plain ink means you are owed, the recessive rung means settled, and NEVER a
// green: a settled balance is a fact, not a reward.
//
//   * `Section`  — label · count/meta · one text verb · rows · an empty line
//                  in its own words.
//   * `LedgerRow` — person chip · title · meta sentence · optional proportion
//                  bar · optional status chip · figure block · up to ONE quiet
//                  trailing verb, because this is a touch seat. A pending row
//                  takes the 2px leading rule.
//   * `FieldRow` — key column · value or chips · a note carrying the rule.
//   * `Hero`     — display-rung figure · label · the sentence that says where
//                  the figure came from · up to two secondary verbs.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { displayText } from "@centraid/blueprints/apps/_shared/untrusted";
import { figureTone, proportion } from "@centraid/blueprints/apps/tally/format";
import type { FigureTone } from "@centraid/blueprints/apps/tally/format";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** The 2px leading rule an unsettled write's row takes (§5). */
const PENDING_RULE = 2;
const BAR_HEIGHT = 3;
const CHIP_SIZE = 28;

export function toneColor(tone: FigureTone, colors: ThemeColors): string {
  if (tone === "net") return colors.net;
  return tone === "owed" ? colors.text : colors.textFaint;
}

// ─── Figure ─────────────────────────────────────────────────────────────────

export interface FigureProps {
  /** Already derived by the queries' one balance engine. Never folded here. */
  netMinor: number;
  /** The amount, as `format.money` / `format.netFigure` rendered it. */
  text: string;
  /** What the figure MEANS, under it. Empty on a level balance, because a
   *  level balance has no direction to name. */
  sub?: string;
  /** Overrides the sign convention where the row's own stance decides it —
   *  a ledger row is `roleTone`, not `figureTone`. */
  tone?: FigureTone;
}

export function Figure({
  netMinor,
  text,
  sub,
  tone,
}: FigureProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const resolved = tone ?? figureTone(netMinor);
  return (
    <View style={styles.figureBlock}>
      <Text style={[styles.figure, { color: toneColor(resolved, colors) }]}>
        {text}
      </Text>
      {sub ? <Text style={styles.figureSub}>{sub}</Text> : null}
    </View>
  );
}

// ─── Section ────────────────────────────────────────────────────────────────

export interface SectionProps {
  label: string;
  meta?: string;
  /** The one underlined text verb a section carries. */
  act?: { label: string; onPress: () => void };
  /** The empty line, in this section's own words. */
  empty?: string;
  children?: React.ReactNode;
  /** Is there anything under the head? Decided by the caller, because a
   *  section with a notice under it is not empty even with no rows. */
  filled: boolean;
}

export function Section({
  label,
  meta,
  act,
  empty,
  children,
  filled,
}: SectionProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>{label}</Text>
        {meta ? <Text style={styles.sectionMeta}>{meta}</Text> : null}
        <View style={styles.spacer} />
        {act ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={act.label}
            onPress={() => act.onPress()}
            hitSlop={8}
          >
            <Text style={styles.sectionAct}>{act.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {filled ? (
        children
      ) : empty ? (
        <Text style={styles.empty}>{empty}</Text>
      ) : null}
    </View>
  );
}

// ─── Ledger row ─────────────────────────────────────────────────────────────

export interface LedgerRowProps {
  /** The person chip's two letters, in the person's own hue. Absent where the
   *  row is not about one person. */
  initials?: string;
  title: string;
  meta?: string;
  /** A whole percentage of the largest row, or absent. */
  bar?: { value: number; largest: number };
  /** The status word a row wears — PARKED, Paused, departed. */
  chip?: string;
  chipTone?: "seam" | "net";
  figure?: FigureProps;
  /** ONE quiet trailing verb: this is a touch seat, and §5 caps it at one. */
  act?: { label: string; onPress: () => void };
  /** An unsettled write. Takes the 2px leading rule and says so in its meta. */
  pending?: boolean;
  onPress?: () => void;
}

export function LedgerRow({
  initials,
  title,
  meta,
  bar,
  chip,
  chipTone,
  figure,
  act,
  pending,
  onPress,
}: LedgerRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const width = bar ? proportion(bar.value, bar.largest) : 0;
  const body = (
    <View style={styles.rowBody}>
      {initials ? (
        <View style={styles.personChip}>
          <Text style={styles.personChipText}>{initials}</Text>
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {displayText(title)}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={styles.rowMeta}>
            {meta}
          </Text>
        ) : null}
        {bar ? (
          <View style={styles.barTrack}>
            <View
              style={[
                styles.barFill,
                { backgroundColor: colors.textFaint, width: `${width}%` },
              ]}
            />
          </View>
        ) : null}
      </View>
      {chip ? (
        <Text
          style={[
            styles.chip,
            {
              borderColor: chipTone === "net" ? colors.net : colors.seam,
              color: chipTone === "net" ? colors.net : colors.textSoft,
            },
          ]}
        >
          {chip}
        </Text>
      ) : null}
      {figure ? <Figure {...figure} /> : null}
    </View>
  );
  return (
    <View
      style={[
        styles.row,
        pending
          ? {
              borderStartColor: colors.textFaint,
              borderStartWidth: PENDING_RULE,
            }
          : undefined,
      ]}
    >
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${displayText(title)}. ${meta ?? ""}`}
          onPress={onPress}
          style={styles.rowPress}
        >
          {body}
        </Pressable>
      ) : (
        <View style={styles.rowPress}>{body}</View>
      )}
      {act ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${act.label}. ${displayText(title)}`}
          onPress={() => act.onPress()}
          style={styles.rowAct}
        >
          <Text style={styles.rowActText}>{act.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Field row ──────────────────────────────────────────────────────────────

export interface FieldRowProps {
  label: string;
  value?: string;
  /** The note that carries the rule, and where relevant the gap tag. */
  note?: string;
  children?: React.ReactNode;
}

export function FieldRow({
  label,
  value,
  note,
  children,
}: FieldRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldKey}>{label}</Text>
      <View style={styles.fieldValue}>
        {value ? <Text style={styles.fieldText}>{value}</Text> : null}
        {children}
        {note ? <Text style={styles.fieldNote}>{note}</Text> : null}
      </View>
    </View>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────────────

export interface HeroProps {
  /** The display-rung figure, already rendered by `format`. */
  figure: string;
  netMinor: number;
  label: string;
  /** The sentence that says where the figure came from. */
  sub: string;
  acts?: readonly { label: string; onPress: () => void }[];
}

export function Hero({
  figure,
  netMinor,
  label,
  sub,
  acts,
}: HeroProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tone = figureTone(netMinor);
  return (
    <View style={styles.hero}>
      <Text style={[styles.heroFigure, { color: toneColor(tone, colors) }]}>
        {figure}
      </Text>
      <Text style={styles.heroLabel}>{label}</Text>
      <Text style={styles.heroSub}>{sub}</Text>
      {acts && acts.length > 0 ? (
        <View style={styles.heroActs}>
          {acts.slice(0, 2).map((act) => (
            <Pressable
              key={act.label}
              accessibilityRole="button"
              accessibilityLabel={act.label}
              onPress={() => act.onPress()}
              style={styles.heroAct}
            >
              <Text style={styles.heroActText}>{act.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ─── The window's foot ──────────────────────────────────────────────────────

export function WindowFoot({
  text,
  onMore,
  moreLabel,
}: {
  text: string | null;
  onMore?: () => void;
  moreLabel: string;
}): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (!text) return null;
  return (
    <View style={styles.foot}>
      <Text style={styles.footText}>{text}</Text>
      {onMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={moreLabel}
          onPress={onMore}
          hitSlop={8}
        >
          <Text style={styles.sectionAct}>{moreLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    barFill: { height: BAR_HEIGHT },
    barTrack: {
      backgroundColor: colors.bgSunken,
      borderRadius: radii.xs,
      height: BAR_HEIGHT,
      marginTop: spacing[1],
      overflow: "hidden",
    },
    chip: {
      ...t("control"),
      borderRadius: radii.sm,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing[2],
      paddingVertical: 2,
    },
    empty: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    field: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    fieldKey: { ...t("annotLabel"), color: colors.textFaint, width: 104 },
    fieldNote: { ...t("mono"), color: colors.textFaint },
    fieldText: { ...t("small"), color: colors.text },
    fieldValue: { flex: 1, gap: spacing[2], minWidth: 0 },
    figure: { ...t("labelOn"), color: colors.text, textAlign: "right" },
    figureBlock: { alignItems: "flex-end", minWidth: 72 },
    figureSub: { ...t("mono"), color: colors.textFaint, textAlign: "right" },
    foot: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    footText: { ...t("mono"), color: colors.textFaint, flex: 1 },
    hero: {
      gap: spacing[1],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[4],
    },
    heroAct: {
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: spacing[3],
    },
    heroActText: { ...t("control"), color: colors.text },
    heroActs: { flexDirection: "row", gap: spacing[2], marginTop: spacing[3] },
    heroFigure: { ...t("display") },
    heroLabel: { ...t("eyebrow"), color: colors.textSoft },
    heroSub: { ...t("small"), color: colors.textSoft, marginTop: spacing[2] },
    personChip: {
      alignItems: "center",
      backgroundColor: colors.bgSunken,
      borderRadius: radii.sm,
      height: CHIP_SIZE,
      justifyContent: "center",
      width: CHIP_SIZE,
    },
    personChipText: { ...t("mono"), color: colors.textSoft },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
    },
    rowAct: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    rowActText: { ...t("control"), color: colors.text },
    rowBody: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 56,
      minWidth: 0,
      paddingVertical: spacing[2],
    },
    rowMeta: { ...t("mono"), color: colors.textFaint },
    rowPress: { flex: 1, minWidth: 0, paddingHorizontal: spacing[4] },
    rowText: { flex: 1, gap: 2, minWidth: 0 },
    rowTitle: { ...t("small"), color: colors.text },
    section: { paddingTop: spacing[4] },
    sectionAct: { ...t("control"), color: colors.text },
    sectionHead: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      paddingBottom: spacing[2],
      paddingHorizontal: spacing[4],
    },
    sectionLabel: { ...t("eyebrow"), color: colors.text },
    sectionMeta: { ...t("mono"), color: colors.textFaint, flexShrink: 1 },
    spacer: { flex: 1 },
  });
