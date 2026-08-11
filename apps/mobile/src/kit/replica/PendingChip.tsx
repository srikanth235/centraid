import React from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../components/NativeText";
import { radii, t, useTheme } from "../theme";
import type { PendingRowMark } from "./pending-rows";

/**
 * The one chip a list row wears while its write is unsettled (issue #738).
 *
 * Quiet by default — a queued change is normal on a phone, and the row itself
 * is already the reassurance that nothing was lost. The reason is spelled out
 * on the row only when a member is waiting on somebody else (`parked`); for
 * `queued`/`sending` it stays in the accessible label so a screen reader still
 * gets the whole sentence without every row repeating it.
 */
export default function PendingChip({
  mark,
}: {
  mark: PendingRowMark;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <View
        accessible
        accessibilityLabel={`${mark.label}: ${mark.reason}`}
        style={[styles.chip, { backgroundColor: colors.bgSunken }]}
      >
        <Text style={[t("control"), { color: colors.textSoft }]}>
          {mark.label}
        </Text>
      </View>
      {mark.status === "parked" ? (
        <Text style={[t("small"), styles.reason, { color: colors.textFaint }]}>
          {mark.reason}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  reason: { flexShrink: 1 },
  wrap: { alignItems: "center", flexDirection: "row", gap: 6 },
});
