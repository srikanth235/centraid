import React from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
import VaultBar from "../../screens/home/VaultBar";
import type { TasksBandDestinationKey } from "./tasks-band";
import TasksBand from "./TasksBand";

export interface TasksScreenProps {
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
  const { bandOwner } = useBandOwner("tasks");

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
