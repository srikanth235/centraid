// The head every place inside the Tasks screen draws for itself.
//
// The back control names the DESTINATION it returns to, never the word "Back"
// (README §Cross-app standardisation) — and it returns to a place within this
// screen, because Tasks has one route and the navigator has nothing to pop.

import React from "react";
import { Pressable, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { TasksStyles } from "./TasksHome.styles";

export interface TasksPlaceHeaderProps {
  title: string;
  /** The return target's own name, used as the control's accessible label. */
  backTo: string;
  onBack: () => void;
  styles: TasksStyles;
}

export default function TasksPlaceHeader({
  title,
  backTo,
  onBack,
  styles,
}: TasksPlaceHeaderProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.placeHead}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back to ${backTo}`}
        onPress={onBack}
        style={styles.back}
      >
        <Icon name="chevron-left" size={22} color={colors.text} />
        <Text style={styles.backLabel}>{backTo}</Text>
      </Pressable>
      <Text numberOfLines={1} style={styles.placeTitle}>
        {title}
      </Text>
    </View>
  );
}
