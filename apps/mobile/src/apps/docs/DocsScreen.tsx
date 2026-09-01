// Docs shell frame (#821): every surface wraps it; only the Viewer passes
// `hideBand`. Band taps POP home — navigate would re-push DocsHome (RN7).

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import { resolveDocsMoreRoute } from "./docs-band";
import type { DocsBandDestinationKey, DocsMoreRowKey } from "./docs-band";
import DocsBand from "./DocsBand";
import DocsMoreSheet from "./DocsMoreSheet";

export interface DocsScreenComponentProps {
  /** Band tab this surface belongs under. */
  current: DocsBandDestinationKey;
  children: React.ReactNode;
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
  // One latch per app: hand-back applies app-wide.
  const { bandOwner } = useBandOwner("docs");

  const onDestination = (key: DocsBandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    navigation.popTo("DocsHome", { destination: key });
  };

  const onMoreRow = (key: DocsMoreRowKey): void => {
    setMoreOpen(false);
    // Coming due and Search are DocsHome DESTINATIONS, not screens
    // (docs-band.ts: why Search gave up its band slot).
    if (key === "due" || key === "search") {
      navigation.popTo("DocsHome", { destination: key });
      return;
    }
    // Literal screen name per call: navigate's tuple overloads need one.
    const screen = resolveDocsMoreRoute(key);
    switch (screen) {
      case "DocsRecent":
        navigation.navigate("DocsRecent");
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
      {/* Which vault, and whether its gateway is reachable — `VaultHeader`
          calls these "the two facts true on EVERY route", but only the
          springboard drew them, so inside an app both were lost along with the
          product's two global verbs. Above the body, never inside it: frame
          chrome does not scroll away. */}
      <VaultBar />
      {/* Body flex:1 above the band flex:none (§G, via Photos). */}
      <View style={styles.body}>{children}</View>

      {hideBand ? null : (
        <DocsBand
          owner={bandOwner}
          current={current}
          onSelect={onDestination}
          // goBack() no-ops under a deep link; navigate re-pushes Home.
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
