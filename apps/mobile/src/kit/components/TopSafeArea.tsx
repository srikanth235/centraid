import React from "react";
import { View } from "react-native";
import type { ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type SafeAreaEdge = "top" | "bottom";

const TOP_ONLY: readonly SafeAreaEdge[] = ["top"];

export default function TopSafeArea({
  edges = TOP_ONLY,
  style,
  children,
  ...rest
}: ViewProps & {
  edges?: readonly SafeAreaEdge[];
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View
      {...rest}
      style={[
        style,
        edges.includes("top") ? { paddingTop: insets.top } : null,
        edges.includes("bottom") ? { paddingBottom: insets.bottom } : null,
      ]}
    >
      {children}
    </View>
  );
}
