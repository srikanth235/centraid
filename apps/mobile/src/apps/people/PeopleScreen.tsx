// The frame every People surface sits in (v12 handoff, § Nav; issue #821).
//
// The same predicate `PhotosScreen.tsx` states for Photos: every screen in the
// stack renders the claimed band and the Home capsule, so a pushed screen can
// never arrive as a dead end whose only way out is the OS back gesture. A
// screen wraps itself in this component and cannot forget the band, cannot
// forget the capsule, and cannot forget to keep its content ABOVE the bar —
// the content slot is a `flex:1` sibling above the band, so the viewport is
// genuinely shorter by the band's height rather than scrolling under it.
//
// People has no selection mode and no More sheet, so this shell is the frame,
// the band, and nothing else. Screens keep their own heads (title, back row,
// verbs) — those differ per screen and the band does not.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
import type { PeopleShellNavigation } from "../../navigation";
import type { PeopleBandKey } from "./people-band";
import PeopleBand from "./PeopleBand";

export interface PeopleScreenProps {
  /** Which of the three this surface belongs under. A pushed screen names the
   *  destination it was reached from, so the band keeps saying where the
   *  member is. */
  current: PeopleBandKey;
  children: React.ReactNode;
  /** Hide the band while a modal sheet owns the foot (the confirms). */
  bandHidden?: boolean;
}

export default function PeopleScreen({
  current,
  children,
  bandHidden,
}: PeopleScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<PeopleShellNavigation>();
  // The frame's latch, per app — the member's hand-back applies to every
  // People surface at once (`kit/band/band-owner.ts`).
  const { bandOwner } = useBandOwner("people");
  const styles = useMemo(() => makeStyles(), []);

  const onDestination = (key: PeopleBandKey): void => {
    // POP, never push: the three destinations all live on the stack's home
    // surface, and `PeopleHome` is this stack's initial route, so `popTo`
    // always finds it (see `PhotosScreen.tsx` for the React Navigation 7
    // reasoning).
    navigation.popTo("PeopleHome", { destination: key });
  };

  return (
    <View
      style={[
        styles.frame,
        { backgroundColor: colors.bg, paddingTop: insets.top },
      ]}
    >
      <View style={styles.body}>{children}</View>
      {bandHidden === true ? null : (
        <PeopleBand
          owner={bandOwner}
          current={current}
          onSelect={onDestination}
          onHome={() => navigation.popTo("Home")}
        />
      )}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    body: { flex: 1 },
    frame: { flex: 1 },
  });
