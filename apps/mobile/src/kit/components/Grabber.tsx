import React from "react";
import { StyleSheet, View } from "react-native";

import { useTheme, radii } from "../theme";

export default function Grabber(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[styles.bar, { backgroundColor: colors.textGhost }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderRadius: radii.sm,
    height: 5,
    width: 36,
  },
  wrap: {
    alignItems: "center",
    paddingBottom: 4,
    paddingTop: 6,
  },
});
