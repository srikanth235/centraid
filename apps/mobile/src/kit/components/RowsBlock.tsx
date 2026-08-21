// ROWS — the workhorse of every operational page (#765, spec §9).
//
// One bordered container, rows separated by a hairline, each row a 44pt
// target carrying a title, an optional sub line, an optional state word and at
// most ONE trailing verb. Three rules are load-bearing and easy to undo:
//
//  1. The TITLE is always primary ink, even on a net-toned row. Only the sub
//     and the state word take `net` — a row that "leaves the device" says so
//     with its metadata, not by recolouring the thing it is about.
//  2. The trailing verb is ALWAYS outlined, dangerous or not. A filled button
//     inside a list row would be the second filled commit on a page that is
//     allowed exactly one.
//  3. `off` recedes on the LEAF (disabled ink on the title, a disabled button)
//     and never as a container opacity. `struck` recedes the same way and adds
//     the rule through the title: a revoked holder stays on the record, so the
//     row keeps its height and its place in the list.
//
// `children` is the per-row escape hatch: a row that has to open something in
// place (Notifications' outbox editor) renders it under its own line, inside
// the same cell, so the divider still separates one record from the next.
//
// Every string is the caller's.

import React, { useMemo } from "react";
import { View } from "react-native";

import type { ActionData, RowData } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import Button from "./Button";
import { Text } from "./NativeText";
import { styles } from "./RowsBlock.styles";

/**
 * A row's trailing verb. It is an OBJECT and not a flat `action` string beside
 * an `onAction` handler, because the flat pair had nowhere to put `hint` — so
 * ten rows that all say "Open" announced themselves identically to a screen
 * reader here while the shell named each one.
 */
export interface RowsBlockAction extends ActionData {
  onPress: () => void;
}

/** `title`, `sub`, `meta` and the `net` / `dangerous` / `off` flags come from
 *  the shared contract, where each one is documented once. */
export interface RowsBlockRow extends RowData {
  /** Stable identity for the list; never rendered. */
  key: string;
  action?: RowsBlockAction;
  /** Rendered under the row's own line, inside the same cell. */
  children?: React.ReactNode;
}

export interface RowsBlockProps {
  rows: readonly RowsBlockRow[];
  /** Named for a screen reader when the list is not preceded by a section. */
  accessibilityLabel?: string;
}

function metaInk(row: RowsBlockRow, colors: ThemeColors): string {
  return row.net === true ? colors.net : colors.textFaint;
}

export default function RowsBlock({
  rows,
  accessibilityLabel,
}: RowsBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      block: {
        backgroundColor: colors.bgElev,
        borderColor: colors.line,
      },
      row: { borderTopColor: colors.line },
    }),
    [colors]
  );
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="list"
      style={[styles.block, ink.block]}
    >
      {rows.map((row, index) => {
        const rowAction = row.action;
        return (
          <View
            key={row.key}
            style={[
              styles.row,
              ink.row,
              index === 0 ? styles.rowFirst : undefined,
            ]}
          >
            <View style={styles.line}>
              <View style={styles.text}>
                <Text
                  style={[
                    styles.title,
                    row.struck === true ? styles.struck : undefined,
                    {
                      color:
                        row.off === true || row.struck === true
                          ? colors.textDisabled
                          : colors.text,
                    },
                  ]}
                >
                  {row.title}
                </Text>
                {row.sub ? (
                  <Text style={[styles.sub, { color: metaInk(row, colors) }]}>
                    {row.sub}
                  </Text>
                ) : null}
              </View>
              {row.meta ? (
                <Text
                  numberOfLines={1}
                  style={[styles.meta, { color: metaInk(row, colors) }]}
                >
                  {row.meta}
                </Text>
              ) : null}
              {rowAction ? (
                <Button
                  // `hint` is what distinguishes ten identical verbs. It is an
                  // accessibility HINT and not a label, because the control
                  // already renders its visible word (#708 B.4).
                  accessibilityHint={rowAction.hint}
                  disabled={row.off === true}
                  label={rowAction.label}
                  onPress={() => rowAction.onPress()}
                  style={styles.action}
                  variant={row.dangerous === true ? "destructive" : "secondary"}
                />
              ) : null}
            </View>
            {row.children ? (
              <View style={styles.expansion}>{row.children}</View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
