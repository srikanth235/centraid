import React from "react";
import { Pressable, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import { TASKS_MORE_ROWS } from "./tasks-band";
import { morePlace } from "./tasks-places";
import type { TasksMorePlaceKey } from "./tasks-places";
import type { TasksStyles } from "./TasksHome.styles";

export default function TasksMoreSheet({
  styles,
  onSelect,
}: {
  styles: TasksStyles;
  onSelect: (place: TasksMorePlaceKey) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.pane}>
      {TASKS_MORE_ROWS.map((row) => (
        <Pressable
          key={String(row.shelf)}
          accessibilityRole="button"
          accessibilityLabel={row.label}
          onPress={() => onSelect(morePlace(row.shelf))}
          style={styles.projectRow}
        >
          <Icon name={row.icon} size={16} color={colors.textSoft} />
          <Text style={styles.title}>{row.label}</Text>
          {row.meta ? <Text style={styles.num}>{row.meta}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}
