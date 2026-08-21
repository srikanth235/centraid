// SECTION — the heading that opens one band of an operational page (#765).
//
// Every ops screen hand-rolled its own heading before this (Approvals'
// `sectionTitle`, Automations' and Insights' panel heads), which is how three
// surfaces ended up with three different rungs for the same object. The block
// is deliberately thin: a rule, an uppercase micro label that never wraps, and
// a numeric count that truncates instead of pushing the label around.
//
// All copy — the label and the count sentence — comes from the caller. This
// file owns geometry and ink, never words.

import React, { useMemo } from "react";
import { View } from "react-native";

import type { SectionCopy } from "@centraid/design/blocks";

import { useTheme } from "../theme";
import { Text } from "./NativeText";
import { styles } from "./SectionBlock.styles";

/** `label` + `meta`, shared with the shell — this kit adds nothing. */
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
