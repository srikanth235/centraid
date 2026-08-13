// BARS — runs per day, as ten stacked columns (#765, spec §9).
//
// The chart says one thing: how much ran, and how much of it failed. So it
// spends exactly one colour — `net` on the failed cap — and draws the rest in
// tertiary ink. There is no gradient, no axis grid, no hover tooltip and no
// vector runtime; the previous sparkline had all four and said less.
//
// A chart is unreadable to a screen reader whatever it draws, so the whole
// block carries ONE image-role label the caller composes ("Runs per day over
// the last 30 days"), and each column names itself for anyone exploring by
// touch.

import React, { useMemo } from "react";
import { View } from "react-native";

import { useTheme } from "../theme";
import { barColumns } from "./bars-model";
import type { BarDatum } from "./bars-model";
import { COLUMN_COUNT, styles } from "./BarsBlock.styles";
import { Text } from "./NativeText";

export interface BarsBlockProps {
  data: readonly BarDatum[];
  /** The three axis marks, oldest → newest. */
  axis: readonly [string, string, string];
  /** The two outcome words. OPTIONAL as a PAIR — a chart that names one
   *  outcome and not the other has spent the colour without explaining it, so
   *  either both words are given or the legend row is not drawn (the DOM kit's
   *  `legend?: { ok, fail }` shape, in this surface's prop grammar). */
  legendSucceeded?: string;
  legendFailed?: string;
  /** The whole chart, in one sentence. */
  accessibilityLabel: string;
}

export default function BarsBlock({
  data,
  axis,
  legendSucceeded,
  legendFailed,
  accessibilityLabel,
}: BarsBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  const columns = useMemo(() => barColumns(data, COLUMN_COUNT), [data]);
  const ink = useMemo(
    () => ({
      block: { backgroundColor: colors.bgElev, borderColor: colors.line },
      failed: { backgroundColor: colors.net },
      failedLabel: { color: colors.net },
      faint: { color: colors.textFaint },
      legend: { borderTopColor: colors.line },
      succeeded: { backgroundColor: colors.textFaint },
    }),
    [colors]
  );
  return (
    <View style={[styles.block, ink.block]}>
      <View
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="image"
        style={styles.chart}
      >
        {columns.map((column) => (
          <View
            accessibilityLabel={column.label}
            accessibilityRole="text"
            key={column.key}
            style={styles.column}
          >
            {column.failedHeight === null ? null : (
              <View
                style={[
                  styles.failed,
                  ink.failed,
                  { height: column.failedHeight },
                ]}
              />
            )}
            {column.succeededHeight === null ? null : (
              <View
                style={[
                  styles.succeeded,
                  ink.succeeded,
                  column.hasFailed ? undefined : styles.succeededCapped,
                  { height: column.succeededHeight },
                ]}
              />
            )}
          </View>
        ))}
      </View>
      <View style={styles.axis}>
        {axis.map((label) => (
          <Text key={label} style={[styles.axisLabel, ink.faint]}>
            {label}
          </Text>
        ))}
      </View>
      {legendSucceeded && legendFailed ? (
        <View style={[styles.legend, ink.legend]}>
          <Text style={[styles.legendLabel, ink.faint]}>{legendSucceeded}</Text>
          <Text style={[styles.legendLabel, ink.failedLabel]}>
            {legendFailed}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
