// DISTRIBUTION — a breakdown said as labelled proportional rows (#775).
//
// The React Native half of the vocabulary member the shell draws in
// `packages/client/src/react/ui/DistributionBlock.tsx`. Same contract, same
// ordering, same denominator — all three come from `@centraid/design/blocks`,
// so the phone cannot rank a breakdown differently from the desktop looking at
// the same window.
//
// The bar is the `Progress` recipe's rest lowered to native: a sunken track, the
// ink action fill, and the pill cap on both so a one-percent row is still a
// shape. No colour beyond that — a breakdown is not news.
//
// A bar means nothing to a screen reader, so every row states its share in
// words beside it and the whole block carries the name of what it breaks down.

import React, { useMemo } from "react";
import { View } from "react-native";

import { distributionRows } from "@centraid/design/blocks";
import type { DistributionDatum } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import { styles } from "./DistributionBlock.styles";
import { Text } from "./NativeText";

export interface DistributionBlockProps {
  rows: readonly DistributionDatum[];
  /** The whole breakdown, as a sentence — "Spend by harness". */
  accessibilityLabel: string;
  /** What the shares are shares OF: "73% of spend". */
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
