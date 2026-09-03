import React, { useMemo } from "react";
import { View } from "react-native";

import { distributionRows } from "@centraid/design/blocks";
import type { DistributionDatum } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import { styles } from "./DistributionBlock.styles";
import { Text } from "./NativeText";

export interface DistributionBlockProps {
  rows: readonly DistributionDatum[];
  accessibilityLabel: string;
  unit?: string;
}

export default function DistributionBlock({
  rows,
  accessibilityLabel,
  unit,
}: DistributionBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  const measured = useMemo(() => distributionRows(rows), [rows]);
  const ink = useMemo(
    () => ({
      block: { backgroundColor: colors.bgElev, borderColor: colors.line },
      fill: { backgroundColor: colors.accentFill },
      label: { color: colors.text },
      share: { color: colors.textFaint },
      track: { backgroundColor: colors.bgSunken },
    }),
    [colors]
  );
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[styles.block, ink.block]}
    >
      {measured.map((row) => (
        <View key={row.id} style={styles.row}>
          <View style={styles.head}>
            <Text numberOfLines={1} style={[styles.label, ink.label]}>
              {row.label}
            </Text>
            <Text style={[styles.share, ink.share]}>
              {`${String(row.share)}%${unit ? ` ${unit}` : ""}`}
            </Text>
          </View>
          <View style={[styles.track, ink.track]}>
            <View style={[styles.fill, ink.fill, { width: `${row.share}%` }]} />
          </View>
          <Text style={[styles.value, ink.share]}>{row.value}</Text>
        </View>
      ))}
    </View>
  );
}
