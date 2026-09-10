// The denied gate (Tasks spec §3, §5). Denial is DATA: the facts sit in rows
// beside the sentence that names the way out, and the seat writes no row for a
// fact it does not hold.
//
// WHAT IS NOT A FACT: the refusal string itself (#1015, S14 — ruling R-A-18).
// It reaches this pane as `board.error`, which is `caughtError.message` from
// `useSeatPages` — a transport sentence, a SQL fragment or an empty string,
// carried here under the name "Receipt" because the gateway seat calls the
// vault's own refusal a receipt. A citation is not a justification: on a phone
// it is engine vocabulary in the middle of a pane that otherwise says exactly
// what happened and what to do. `useSeatPages` already logs the raw at the
// catch, which is where a debug session starts (docs/logs.md).

import React from "react";
import { View } from "react-native";

import { deniedFacts } from "@centraid/blueprints/apps/tasks/board-view";
import { DENIED } from "@centraid/blueprints/apps/tasks/view-copy";

import { Text } from "../../kit/components/NativeText";
import type { TasksStyles } from "./TasksHome.styles";

export interface TasksDeniedProps {
  scope: string;
  when: string;
  styles: TasksStyles;
}

export default function TasksDenied({
  scope,
  when,
  styles,
}: TasksDeniedProps): React.JSX.Element {
  const facts = deniedFacts({ scope, when });
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
