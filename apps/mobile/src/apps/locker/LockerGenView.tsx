// THE GENERATOR — `locker/gen` (README-Locker §5, "Generator"; FLOWS.md).
//
// A ROUTE OF ITS OWN, because someone who wants a string should not have to
// invent an item to get one. NOTHING HERE IS SAVED: the output is a secret
// nobody has written, it lives in the enumerated bag's `generated` field, and
// the same lock that wipes a reveal wipes it.
//
// LOOK-ALIKES ARE EXCLUDED ALWAYS — in every kind, not as a switch — so a
// password read off a screen and typed on a keypad is the same password. The
// rule is `gen-model.ts`'s, and this screen states it under the chips.
import React, { useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  GEN_LENGTHS,
  generate,
  lengthMeaning,
  readsInclude,
} from "@centraid/blueprints/apps/locker/gen-model";
import type { GenOptions } from "@centraid/blueprints/apps/locker/gen-model";
import {
  GEN_DIGITS,
  GEN_INCLUDE_ROW,
  GEN_KIND_ROW,
  GEN_KINDS,
  GEN_LENGTH_ROW,
  GEN_NOTE,
  GEN_NOTHING_SAVED,
  GEN_PIN_STRENGTH,
  GEN_PUT_ON_ITEM,
  GEN_REGENERATE,
  GEN_SYMBOLS,
  genStrengthCopy,
} from "@centraid/blueprints/apps/locker/route-copy";
import { strength } from "@centraid/blueprints/apps/locker/totp";
import { COPY } from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import type { ChipDef } from "../../kit/components/ChipsBlock";
import { Text } from "../../kit/components/NativeText";
import SectionBlock from "../../kit/components/SectionBlock";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface LockerGenViewProps {
  value: string;
  options: GenOptions;
  onOptions: (next: GenOptions) => void;
  onValue: (next: string) => void;
  onCopy: (value: string) => void;
  onPutOnItem: (value: string) => void;
}

export default function LockerGenView(
  props: LockerGenViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { value, options, onValue } = props;

  useEffect(() => {
    onValue(generate(options));
  }, [options, onValue]);

  const score = strength(value);
  const kindChips: readonly ChipDef[] = GEN_KINDS.map(([kind, label]) => ({
    id: kind,
    label,
    on: options.kind === kind,
    onPress: () =>
      props.onOptions({ ...options, kind: kind as GenOptions["kind"] }),
  }));
  const lengthChips: readonly ChipDef[] = GEN_LENGTHS.map((length) => ({
    id: String(length),
    label: String(length),
    on: options.length === length,
    onPress: () => props.onOptions({ ...options, length }),
  }));
  const includeChips: readonly ChipDef[] = [
    {
      id: "digits",
      label: GEN_DIGITS,
      on: options.digits,
      onPress: () => props.onOptions({ ...options, digits: !options.digits }),
    },
    {
      id: "symbols",
      label: GEN_SYMBOLS,
      on: options.symbols,
      onPress: () => props.onOptions({ ...options, symbols: !options.symbols }),
    },
  ];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.output}>
        <Text selectable style={styles.value}>
          {value}
        </Text>
      </View>
      <Text style={styles.strength}>
        {options.kind === "pin"
          ? GEN_PIN_STRENGTH
          : genStrengthCopy(score.label, value.length)}
      </Text>

      <SectionBlock label={GEN_KIND_ROW} />
      <ChipsBlock accessibilityLabel={GEN_KIND_ROW} chips={kindChips} />

      <SectionBlock label={GEN_LENGTH_ROW} meta={lengthMeaning(options.kind)} />
      <ChipsBlock
        accessibilityLabel={GEN_LENGTH_ROW}
        chips={lengthChips}
        mono
      />

      {readsInclude(options.kind) ? (
        <>
          <SectionBlock label={GEN_INCLUDE_ROW} />
          <ChipsBlock
            accessibilityLabel={GEN_INCLUDE_ROW}
            chips={includeChips}
          />
        </>
      ) : null}

      <Text style={styles.note}>{GEN_NOTE}</Text>
      <Text style={styles.note}>{GEN_NOTHING_SAVED}</Text>

      <View style={styles.acts}>
        <Button label={COPY} onPress={() => props.onCopy(value)} />
        <Button
          label={GEN_REGENERATE}
          onPress={() => onValue(generate(options))}
        />
        <Button
          label={GEN_PUT_ON_ITEM}
          onPress={() => props.onPutOnItem(value)}
          variant="primary"
        />
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    acts: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[4],
    },
    note: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    output: {
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      margin: spacing[4],
      padding: spacing[4],
    },
    scroll: { paddingBottom: spacing[6] },
    strength: {
      ...t("small"),
      color: colors.textSoft,
      paddingHorizontal: spacing[4],
      paddingBottom: spacing[3],
    },
    value: { ...t("display"), color: colors.text },
  });
