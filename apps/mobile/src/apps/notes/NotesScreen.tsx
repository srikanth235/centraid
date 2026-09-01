// The frame every Notes surface sits in, so no screen forgets the band, the
// capsule, or reserving the band's height.

import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
import VaultBar from "../../screens/home/VaultBar";
import type { NotesBandDestinationKey } from "./notes-band";
import NotesBand from "./NotesBand";

export interface NotesScreenProps {
  current: NotesBandDestinationKey;
  onDestination: (key: NotesBandDestinationKey) => void;
  onHome: () => void;
  children: React.ReactNode;
}

export default function NotesScreen({
  current,
  onDestination,
  onHome,
  children,
}: NotesScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // Per app: a handback on one Notes surface is a handback on all of them.
  const { bandOwner } = useBandOwner("notes");

  return (
    <View
      style={[
        styles.frame,
        { backgroundColor: colors.bg, paddingTop: insets.top },
      ]}
    >
      {/* The vault lockup on every route (see `VaultBar`): which vault, which
          gateway, and the product's two global verbs. */}
      <VaultBar />
      {/* Content ends ABOVE the band structurally: the slot is `flex:1` and
          the band below it is `flex:none`, so the scroll viewport is genuinely
          shorter by the band's height. */}
      <View style={styles.body}>{children}</View>

      <NotesBand
        owner={bandOwner}
        current={current}
        onSelect={onDestination}
        onHome={onHome}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  frame: { flex: 1 },
});
