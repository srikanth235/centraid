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
import { columnGap, MAX_COLUMNS, styles } from "./BarsBlock.styles";
import { Text } from "./NativeText";

export interface BarsBlockProps {
  data: readonly BarDatum[];
  /**
   * The marks along the axis, oldest → newest, spread across the plot.
   *
   * TWO OR MORE, and the count is the caller's (#775). It was a fixed triple
   * while the only marks it carried were the relative words "30 days ago /
   * halfway / today" — words a fold into real dates has no use for.
   */
  axis: readonly string[];
  /**
   * One line under the chart naming what the eye just found — the peak day and
   * what it cost. The plot has no value axis, so this is the only place a
   * column's actual magnitude is ever stated.
   */
  note?: string;
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
  note,
  legendSucceeded,
  legendFailed,
  accessibilityLabel,
}: BarsBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  // MAX_COLUMNS is a guard, not a fold: the caller decides how many days a
  // column covers (`dayFold`), and at every window this phone can be asked
  // about that is one column per day up to a month. Sampling inside the block
  // is what made a spike disappear without the screen ever knowing (#775).
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
