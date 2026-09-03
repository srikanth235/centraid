import React, { useMemo } from "react";
import { Pressable, View } from "react-native";

import type { ChipData } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import { styles } from "./ChipsBlock.styles";
import { Text } from "./NativeText";

export interface ChipDef extends ChipData {
  onPress: () => void;
}

export interface ChipsBlockProps {
  chips: readonly ChipDef[];
  mono?: boolean;
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
