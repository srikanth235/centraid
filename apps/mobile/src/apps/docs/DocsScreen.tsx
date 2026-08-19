// The frame every Docs surface sits in (Binding Layer v12 handoff Part 2;
// issue #821) — the same shell shape `PhotosScreen.tsx` proved: a screen that
// wraps itself in it cannot forget the band, cannot forget the Home capsule,
// and cannot forget to reserve the band's height out of its own content.
//
// Every Docs screen renders the band EXCEPT the stage: "The stage drops the
// band, alone among Docs screens, because it is a mode with its own exit
// rather than a place" (handoff deviation 2). A screen opts out with
// `hideBand` — the Viewer passes it; nothing else may.
//
// A band tap from a pushed route NAVIGATES to the stack's home with the
// destination named (`popTo`, never push — React Navigation 7's `navigate`
// pushes a second `DocsHome` instead, the same defect Photos fixed). More is
// a sheet, not a route, so it never reaches `DocsHome` at all.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import { resolveDocsMoreRoute } from "./docs-band";
import type { DocsBandDestinationKey, DocsMoreRowKey } from "./docs-band";
import DocsBand from "./DocsBand";
import DocsMoreSheet from "./DocsMoreSheet";

export interface DocsScreenComponentProps {
  /** Which band tab this surface belongs under. A More-sheet destination
   *  (Recently changed, Starred, Trash, Storage) is `more`: the sheet is how
   *  a member got here, and lighting one of the other four would point at a
   *  shelf they are not looking at. */
  current: DocsBandDestinationKey;
  children: React.ReactNode;
  /** The stage's opt-out (deviation 2). Only the Viewer passes it. */
  hideBand?: boolean;
}

export default function DocsScreen({
  current,
  children,
  hideBand,
}: DocsScreenComponentProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<DocsShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  // The frame's latch, per app — handing the band back on one Docs surface
  // hands it back on all of them (`kit/band/band-owner.ts`).
  const { bandOwner } = useBandOwner("docs");

  const onDestination = (key: DocsBandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // POP, never push: the four shelf destinations all live on `DocsHome`,
    // the stack's initial route, so `popTo` always finds it.
    navigation.popTo("DocsHome", { destination: key });
  };

  const onMoreRow = (key: DocsMoreRowKey): void => {
    setMoreOpen(false);
    // The mapping lives in `docs-band.ts` (tested there); this switch is
    // mechanical dispatch because `navigate`'s tuple overloads need a
    // literal screen name per call.
    const screen = resolveDocsMoreRoute(key);
    switch (screen) {
      case "DocsRecent":
        navigation.navigate("DocsRecent");
        break;
      case "DocsStarred":
        navigation.navigate("DocsStarred");
        break;
      case "DocsTrash":
        navigation.navigate("DocsTrash");
        break;
      case "DocsStorage":
        navigation.navigate("DocsStorage");
        break;
      case "DocsCapabilities":
        navigation.navigate("DocsCapabilities");
        break;
      case "DocsAdd":
        navigation.navigate("DocsAdd");
        break;
      default: {
        const exhaustive: never = screen;
        throw new Error(`Unhandled More screen: ${String(exhaustive)}`);
      }
    }
  };

  const frame = useMemo(
    () => [
      styles.frame,
      { backgroundColor: colors.bg, paddingTop: insets.top },
    ],
    [colors, insets.top]
  );

  return (
    <View style={frame}>
      {/* Content ends ABOVE the band structurally: the slot is `flex:1` and
          the band below it is `flex:none`, so the scroll viewport is
          genuinely shorter by the band's height (§G, via Photos). */}
      <View style={styles.body}>{children}</View>

      {hideBand ? null : (
        <DocsBand
          owner={bandOwner}
          current={current}
          onSelect={onDestination}
          // HOME via popTo — `goBack()` is a no-op under a deep link and
          // `navigate` pushes a second Home on React Navigation 7.
          onHome={() => navigation.popTo("Home")}
        />
      )}

      <DocsMoreSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  frame: { flex: 1 },
});
