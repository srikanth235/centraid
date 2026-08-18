// PEOPLE ON THE PHONE — deliberately empty, awaiting its design handoff.
//
// The native directory (a roster, per-person channels and cadence, the merge
// picker) was REMOVED for the same reason the phone's Docs drive was: it was
// drawn before the Binding Layer v11 handoff, so keeping it would have meant
// maintaining a grammar the rebuild is going to replace. See
// `../docs/DocsHome.tsx` for the full reasoning — this is the same decision,
// taken once.
//
// The `people` manifest, its twenty-eight actions and seven queries, and the
// vault scopes they run under are untouched: a design handoff redraws screens,
// not handlers. The desktop People blueprint is in the same state
// (`packages/blueprints/apps/people/app-root.tsx`).

import React, { useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";

import EmptyBlock from "../../kit/components/EmptyBlock";
import HomeKey from "../../kit/components/HomeKey";
import PlaceHeader from "../../kit/components/PlaceHeader";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { pageMargin, spacing, useTheme } from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";

export default function PeopleHome({
  navigation,
}: PeopleScreenProps<"PeopleHome">): React.JSX.Element {
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
            <PlaceHeader title="People" />
          </View>
        </View>
        <View style={styles.body}>
          <EmptyBlock
            body="People on this phone is being rebuilt from its design handoff."
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
