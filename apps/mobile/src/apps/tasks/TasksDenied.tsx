import React from "react";
import { View } from "react-native";

import { deniedFacts } from "@centraid/blueprints/apps/tasks/board-view";
import { DENIED } from "@centraid/blueprints/apps/tasks/view-copy";

import { Text } from "../../kit/components/NativeText";
import type { TasksStyles } from "./TasksHome.styles";

export interface TasksDeniedProps {
  receipt: string;
  scope: string;
  when: string;
  styles: TasksStyles;
}

export default function TasksDenied({
  receipt,
  scope,
  when,
  styles,
}: TasksDeniedProps): React.JSX.Element {
  const facts = deniedFacts({ receipt, scope, when });
  return (
    <View accessibilityRole="alert" style={styles.pane}>
      <Text style={styles.emptyTitle}>{DENIED.title}</Text>
      <Text style={styles.lead}>{DENIED.bodyA}</Text>
      <Text style={styles.lead}>{DENIED.bodyB}</Text>
      {facts.map((fact) => (
        <View key={fact.key} style={styles.fieldRow}>
          <Text style={styles.fieldKey}>{fact.label}</Text>
          <Text style={styles.fieldValue}>{fact.value}</Text>
        </View>
      ))}
    </View>
  );
}
