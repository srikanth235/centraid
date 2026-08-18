// DOCS ON THE PHONE — deliberately empty, awaiting its design handoff.
//
// The native drive (a folder browser, a document viewer, per-item custody and
// a share sheet) was REMOVED rather than left to rot: it was built before the
// Binding Layer v11 handoff and answered an earlier grammar, so every screen
// it drew would have had to be unlearned before it could be redrawn. A surface
// that is wrong costs more than a surface that is absent, because the wrong one
// still has to be maintained, tested and explained.
//
// What survives the removal is everything that was never a drawing question:
// the `docs` manifest, its actions and queries, the vault scopes and the
// receipts. The rebuild is a rendering job against a contract that never left.
//
// The wall is the frame's own page — the leave key and the place's title — so a
// member who taps Docs on the springboard lands somewhere recognisably Docs and
// can leave the way they always do, rather than meeting a blank screen with no
// exit. It is deliberately NOT `FeatureOffPlace`: that wall says the GATEWAY
// switched something off, which is a different fact with a different remedy.

import React, { useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";

import EmptyBlock from "../../kit/components/EmptyBlock";
import HomeKey from "../../kit/components/HomeKey";
import PlaceHeader from "../../kit/components/PlaceHeader";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { pageMargin, spacing, useTheme } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";

export default function DocsHome({
  navigation,
}: DocsScreenProps<"DocsHome">): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ backgroundColor: colors.bg }), [colors]);
  const leave = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <TopSafeArea edges={["top"]} style={[styles.safe, ink]}>
      <View style={styles.page}>
        <View style={styles.head}>
          <HomeKey onPress={leave} variant="leave" />
          <View style={styles.headBar}>
            {/* No verbs: there is nothing here to act on yet. */}
            <PlaceHeader title="Docs" />
          </View>
        </View>
        <View style={styles.body}>
          <EmptyBlock
            body="Docs on this phone is being rebuilt from its design handoff."
            title="Not here yet"
          />
        </View>
      </View>
    </TopSafeArea>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: spacing[6], paddingHorizontal: pageMargin },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: pageMargin,
  },
  headBar: { flex: 1, minWidth: 0 },
  page: { flex: 1 },
  safe: { flex: 1 },
});
