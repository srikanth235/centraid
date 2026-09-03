import React from "react";
import { Pressable, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { TasksStyles } from "./TasksHome.styles";

export interface TasksPlaceHeaderProps {
  title: string;
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
