// For COVER-presented screens (`COVER_OPTIONS` in App.tsx): inside that
// native fullScreenModal, `SafeAreaView` resolves top insets to ZERO (the
// header draws through the status bar); seeding `initialWindowMetrics` does
// not fix it — tried and measured — while `useSafeAreaInsets()` reports the
// real values. Props match `SafeAreaView`: migrate by renaming the element.

import React from "react";
import { View } from "react-native";
import type { ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type SafeAreaEdge = "top" | "bottom";

/** Process-wide literal — a fresh array would break referential equality. */
const TOP_ONLY: readonly SafeAreaEdge[] = ["top"];

/** Every `View` prop passes through. */
export default function TopSafeArea({
  edges = TOP_ONLY,
  style,
  children,
  ...rest
}: ViewProps & {
  /** Which edges to inset; defaults to top. */
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
