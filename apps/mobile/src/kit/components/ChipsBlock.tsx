// CHIPS — the filter row that carries the load when a page gets full (#765).
//
// This is NOT `SelectChip` (that is the multi-select entry, a different
// grammar) and NOT `OptionSheet` (a destination-weight decision). A chip row
// is a one-tap narrowing of what is already on screen, so it stays on screen.
//
// The active chip states itself three ways, none of them a hue: a bolder label
// from the held pair, a primary-ink border, and a sunken ground. Colour is
// spent on `net` and nothing else.

import React, { useMemo } from "react";
import { Pressable, View } from "react-native";

import type { ChipData } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import { styles } from "./ChipsBlock.styles";
import { Text } from "./NativeText";

/** `id` + `label` + `on` are shared; this kit puts the handler on each chip
 *  rather than on the group, because a native row has no form element to
 *  delegate through. */
export interface ChipDef extends ChipData {
  onPress: () => void;
}

export interface ChipsBlockProps {
  chips: readonly ChipDef[];
  /** The numeric variant — a window picker rather than a word filter. */
  mono?: boolean;
  /** Names the GROUP; each chip already announces itself and its state. */
  accessibilityLabel?: string;
}

export default function ChipsBlock({
  chips,
  mono,
  accessibilityLabel,
}: ChipsBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      chip: { backgroundColor: colors.bg, borderColor: colors.line },
      chipOn: { backgroundColor: colors.bgSunken, borderColor: colors.text },
      label: { color: colors.textSoft },
      labelOn: { color: colors.text },
    }),
    [colors]
  );
  const base = mono === true ? styles.monoLabel : styles.label;
  const held = mono === true ? styles.monoLabelOn : styles.labelOn;
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tablist"
      style={styles.row}
    >
      {chips.map((chip) => {
        const on = chip.on === true;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            key={chip.id}
            onPress={() => chip.onPress()}
            style={[styles.chip, on ? ink.chipOn : ink.chip]}
          >
            <Text
              numberOfLines={1}
              style={[on ? held : base, on ? ink.labelOn : ink.label]}
            >
              {chip.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
