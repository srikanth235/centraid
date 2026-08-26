// Runs-per-day bars (#765 §9): ONE image-role label; each column labels itself
// for touch. Failed cap wears `net` ink, rest tertiary.

import React, { useMemo } from "react";
import { View } from "react-native";

import { useTheme } from "../theme";
import { barColumns } from "./bars-model";
import type { BarDatum } from "./bars-model";
import { columnGap, MAX_COLUMNS, styles } from "./BarsBlock.styles";
import { Text } from "./NativeText";

export interface BarsBlockProps {
  data: readonly BarDatum[];
  /** Axis marks, oldest → newest; TWO OR MORE (#775). */
  axis: readonly string[];
  /** Peak-day note — the only magnitude ever stated. */
  note?: string;
  /** Both as a pair, or no legend row. */
  legendSucceeded?: string;
  legendFailed?: string;
  /** Whole chart in one sentence. */
  accessibilityLabel: string;
}

export default function BarsBlock({
  data,
  axis,
  note,
  legendSucceeded,
  legendFailed,
  accessibilityLabel,
}: BarsBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  // Guard, not fold: caller decides days-per-column (#775).
  const columns = useMemo(() => barColumns(data, MAX_COLUMNS), [data]);
  const gap = useMemo(() => ({ gap: columnGap(columns.length) }), [columns]);
  const ink = useMemo(
    () => ({
      block: { backgroundColor: colors.bgElev, borderColor: colors.line },
      failed: { backgroundColor: colors.net },
      failedLabel: { color: colors.net },
      faint: { color: colors.textFaint },
      legend: { borderTopColor: colors.line },
      noteInk: { color: colors.textSoft },
      succeeded: { backgroundColor: colors.textFaint },
    }),
    [colors]
  );
  return (
    <View style={[styles.block, ink.block]}>
      <View
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="image"
        style={[styles.chart, gap]}
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
      {note ? <Text style={[styles.note, ink.noteInk]}>{note}</Text> : null}
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
