import React from "react";
import { FlatList, View } from "react-native";

import { remindingTasks } from "@centraid/blueprints/apps/tasks/logic";
import type { Task } from "@centraid/blueprints/apps/tasks/types";
import {
  NOTIFY_COPY,
  REMINDER_NOTE_A,
} from "@centraid/blueprints/apps/tasks/view-copy";

import { Text } from "../../kit/components/NativeText";
import TaskRow from "./TaskRow";
import { REMINDER_NONE, REMINDER_SEAT_NOTE } from "./tasks-seat-copy";
import type { TasksStyles } from "./TasksHome.styles";

export interface TasksRemindersProps {
  tasks: readonly Task[];
  now: string;
  styles: TasksStyles;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
}

export default function TasksReminders({
  tasks,
  now,
  styles,
  onToggle,
  onOpen,
}: TasksRemindersProps): React.JSX.Element {
  const rows = remindingTasks(tasks);
  const head = (
    <View style={styles.pane}>
      <Text style={styles.lead}>{REMINDER_NOTE_A}</Text>
      <Text style={styles.lead}>{REMINDER_SEAT_NOTE}</Text>
      {rows.length === 0 ? (
        <Text style={styles.lead}>{REMINDER_NONE}</Text>
      ) : null}
    </View>
  );
  const foot = (
    <View style={styles.pane}>
      <Text style={styles.fieldNote}>{NOTIFY_COPY.rule}</Text>
      <View style={styles.chipRow}>
        {NOTIFY_COPY.snoozes.map((option) => (
          <Text key={option} style={styles.num}>
            {option}
          </Text>
        ))}
      </View>
    </View>
  );
  return (
    <FlatList
      data={rows}
      keyExtractor={(task) => task.task_id}
      renderItem={({ item }) => (
        <TaskRow
          task={item}
          now={now}
          styles={styles}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      )}
      ListHeaderComponent={head}
      ListFooterComponent={foot}
      contentContainerStyle={styles.listContent}
    />
  );
}
