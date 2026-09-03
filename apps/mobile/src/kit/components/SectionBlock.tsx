import React, { useMemo } from "react";
import { View } from "react-native";

import type { SectionCopy } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import { Text } from "./NativeText";
import { styles } from "./SectionBlock.styles";

export type SectionBlockProps = SectionCopy;

export default function SectionBlock({
  label,
  meta,
}: SectionBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      label: { color: colors.text },
      meta: { color: colors.textFaint },
      row: { borderTopColor: colors.line },
    }),
    [colors]
  );
  return (
    <View style={[styles.row, ink.row]}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={[styles.label, ink.label]}
      >
        {label}
      </Text>
      {meta ? (
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.meta, ink.meta]}
        >
          {meta}
        </Text>
      ) : null}
    </View>
  );
}
