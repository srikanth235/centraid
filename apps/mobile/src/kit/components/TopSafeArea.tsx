// The safe area, for screens presented as a COVER.
//
// Every screen in this app is registered with `COVER_OPTIONS` (App.tsx) — a
// native `fullScreenModal`. Inside that presentation the `SafeAreaView` form
// from react-native-safe-area-context resolves its insets to ZERO, so a screen
// using it draws its header straight through the status bar: the back chevron
// and the title land on top of the clock. Seeding the provider with
// `initialWindowMetrics` does not change this; it was tried and measured.
//
// `useSafeAreaInsets()` DOES report the real insets under the same
// presentation — which is why Photos' own cover screens (`PhotosHome.tsx`,
// `PhotosScreen.tsx`) have always looked right while every screen using the
// `SafeAreaView` form did not. This component is that working form, named
// once, so a screen gets the correct behaviour by reaching for the obvious
// thing rather than by knowing this footnote.
//
// The prop is deliberately the SAME shape `SafeAreaView` takes, so a screen
// migrates by changing the element name and nothing else.

import React from "react";
import { View } from "react-native";
import type { ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type SafeAreaEdge = "top" | "bottom";

/** Module-level so the default is one array for the process, not a fresh one
 *  per render — a new literal here would break referential equality on every
 *  pass for every screen in the app. */
const TOP_ONLY: readonly SafeAreaEdge[] = ["top"];

/** Every `View` prop passes through — a screen migrating from `SafeAreaView`
 *  keeps its accessibility and layout props untouched. */
export default function TopSafeArea({
  edges = TOP_ONLY,
  style,
  children,
  ...rest
}: ViewProps & {
  /** Which edges to inset. Defaults to the top alone. */
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
