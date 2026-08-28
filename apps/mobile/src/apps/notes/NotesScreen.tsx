// The frame every Notes surface sits in (#882) — the shape `TasksScreen.tsx`
// and `DocsScreen.tsx` proved: a screen that wraps itself in it cannot forget
// the band, cannot forget the Home capsule, and cannot forget to reserve the
// band's height out of its own content.
//
// NOTES HAS ONE ROUTE IN THE NAVIGATOR, so its destinations are places WITHIN
// this screen rather than pushed stack entries — which is why the current
// destination arrives as a prop instead of being read from route params.

import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
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
  // The frame's latch, per app — handing the band back on one Notes surface
  // hands it back on all of them (`kit/band/band-owner.ts`).
  const { bandOwner } = useBandOwner("notes");

  return (
    <View
      style={[
        styles.frame,
        { backgroundColor: colors.bg, paddingTop: insets.top },
      ]}
    >
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
