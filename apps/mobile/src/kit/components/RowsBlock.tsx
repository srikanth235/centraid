// Rows (#765, §9): outlined trailing verb, `off`/`struck` recede on the leaf.

import React, { useMemo } from "react";
import { Pressable, View } from "react-native";

import type { ActionData, RowData } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import Button from "./Button";
import { Text } from "./NativeText";
import { styles } from "./RowsBlock.styles";

// Object, not a flat `action` string: the flat pair had nowhere to put `hint`.
export interface RowsBlockAction extends ActionData {
  onPress: () => void;
}

export interface RowsBlockRow extends RowData {
  key: string;
  action?: RowsBlockAction;
  /**
   * The row itself as a tap target (#1015 R-NY-2): title, sub and meta answer
   * one press. Drawn as the verb's SIBLING, never its parent, so no control is
   * nested inside another and the verb keeps its own hit area.
   */
  onPress?: () => void;
  children?: React.ReactNode;
}

export interface RowsBlockProps {
  rows: readonly RowsBlockRow[];
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
        const rowPress = row.onPress;
        const face = (
          <>
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
          </>
        );
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
              {rowPress ? (
                <Pressable
                  accessibilityHint={rowAction?.hint}
                  accessibilityRole="button"
                  // The same refusal `Button` reports: the state, the flag, and
                  // no handler — an off row recedes on its leaves, never faded.
                  accessibilityState={{ disabled: row.off === true }}
                  disabled={row.off === true}
                  onPress={row.off === true ? undefined : () => rowPress()}
                  style={styles.face}
                >
                  {face}
                </Pressable>
              ) : (
                face
              )}
              {rowAction ? (
                <Button
                  // Hint, not label: the control already renders its visible word (#708 B.4).
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
