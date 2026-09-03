import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { identityInk } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface ColorSwatchRowProps {
  value: string;
  options: readonly string[];
  onChange: (hex: string) => void;
}

export default function ColorSwatchRow({
  value,
  options,
  onChange,
}: ColorSwatchRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      {options.map((hex) => {
        const active = hex.toLowerCase() === value.toLowerCase();
        return (
          <Pressable
            key={hex}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Colour ${hex}`}
            onPress={() => onChange(hex)}
            style={({ pressed }) => [
              styles.swatch,
              {
                backgroundColor: hex,
                borderColor: active ? colors.text : "transparent",
              },
              pressed && styles.pressed,
            ]}
          >
            {active ? (
              <Icon
                name="check"
                size={16}
                color={identityInk(hex, colors.text, colors.textInv)}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const SIZE = 34;

const makeStyles = (_colors: ThemeColors) =>
  StyleSheet.create({
    pressed: { opacity: 0.7 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    swatch: {
      alignItems: "center",
      borderRadius: SIZE / 2,
      borderWidth: 2,
      height: SIZE,
      justifyContent: "center",
      width: SIZE,
    },
  });
