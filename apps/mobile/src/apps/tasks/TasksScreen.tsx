// The frame every Tasks surface sits in (Tasks spec §2; #834) — the same
// shell shape `PhotosScreen.tsx` and `DocsScreen.tsx` proved: a screen that
// wraps itself in it cannot forget the band, cannot forget the Home capsule,
// and cannot forget to reserve the band's height out of its own content.
//
// TASKS HAS ONE ROUTE IN THE NAVIGATOR, so its destinations are places WITHIN
// this screen rather than pushed stack entries — which is why the current
// destination arrives as a prop instead of being read from route params. The
// band's contract is unchanged: exactly one band exists, the frame's latch
// (`useBandOwner`) decides whose, and the capsule never leaves.

import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
import type { TasksBandDestinationKey } from "./tasks-band";
import TasksBand from "./TasksBand";

export interface TasksScreenProps {
  /** Which band tab this surface belongs under. A More-sheet destination is
   *  `more`: the sheet is how a member got here, and lighting one of the other
   *  four would point at a place they are not looking at. */
  current: TasksBandDestinationKey;
  onDestination: (key: TasksBandDestinationKey) => void;
  onHome: () => void;
  children: React.ReactNode;
}

export default function TasksScreen({
  current,
  onDestination,
  onHome,
  children,
}: TasksScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // The frame's latch, per app — handing the band back on one Tasks surface
  // hands it back on all of them (`kit/band/band-owner.ts`).
  const { bandOwner } = useBandOwner("tasks");

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

      <TasksBand
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
