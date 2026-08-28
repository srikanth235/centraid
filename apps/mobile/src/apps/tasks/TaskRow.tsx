// One task row, drawn the same way wherever rows appear (Tasks spec §5).
//
// THREE GESTURES, THREE MEANINGS: the box completes, the body OPENS the task's
// detail place, and a long press picks the row up to file it. A read-only row
// keeps all three affordances visible and attaches the reason instead of
// failing on press.

import React from "react";
import { Pressable, View } from "react-native";

import { readPendingOverlay } from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { Task } from "@centraid/blueprints/apps/tasks/types";
import {
  PENDING_ROW,
  VAULT_MARKER,
} from "@centraid/blueprints/apps/tasks/view-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import {
  READ_ONLY_SOURCE_REASON,
  rowCanWrite,
} from "../../kit/replica/row-provenance";
import { useTheme } from "../../kit/theme";
import { taskRowModel } from "./tasks-row-model";
import type { TasksStyles } from "./TasksHome.styles";

export function isClosed(task: Task): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

export interface TaskRowProps {
  task: Task;
  now: string;
  styles: TasksStyles;
  projectName?: string | null;
  child?: boolean;
  picked?: boolean;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onPickUp?: (task: Task) => void;
  /** The row's ONE act where the place gives it one (the Inbox). */
  act?: { label: string; run: (task: Task) => void };
}

export default function TaskRow({
  task,
  now,
  styles,
  projectName,
  child,
  picked,
  onToggle,
  onOpen,
  onPickUp,
  act,
}: TaskRowProps): React.JSX.Element {
  const { colors } = useTheme();
  // The pending marker is drawn INLINE: one unsettled row in one app is not
  // yet kit vocabulary.
  const pending = readPendingOverlay(
    task as unknown as Record<string, unknown>
  );
  const done = isClosed(task);
  const writable = rowCanWrite(task);
  const { meta, priority } = taskRowModel({
    task,
    now,
    ...(projectName ? { projectName } : {}),
  });

  return (
    <View
      style={[
        styles.rowWrap,
        child ? styles.rowChild : undefined,
        pending ? styles.rowPending : undefined,
        picked ? styles.rowPicked : undefined,
      ]}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={task.title}
        accessibilityState={{ checked: done, disabled: !writable }}
        accessibilityHint={writable ? undefined : READ_ONLY_SOURCE_REASON}
        disabled={!writable}
        onPress={() => onToggle(task)}
        style={styles.box}
      >
        {done ? <Icon name="Check" size={14} color={colors.text} /> : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={task.title}
        accessibilityState={{ selected: picked === true }}
        onPress={() => onOpen(task)}
        {...(writable && onPickUp ? { onLongPress: () => onPickUp(task) } : {})}
        style={styles.rowMain}
      >
        <View style={styles.titleLine}>
          <Text
            numberOfLines={1}
            style={[styles.title, done ? styles.titleDone : undefined]}
          >
            {task.title}
          </Text>
          {priority ? (
            <Text style={styles.priorityMark}>{priority}</Text>
          ) : null}
        </View>
        {meta.length > 0 ? (
          <Text numberOfLines={1} style={styles.num}>
            {meta.map((part, index) => (
              <Text
                key={part.text}
                style={part.attention ? styles.numAttention : undefined}
              >
                {index > 0 ? " · " : ""}
                {part.text}
              </Text>
            ))}
          </Text>
        ) : null}
        {pending ? (
          <Text numberOfLines={1} style={styles.pendingWords}>
            {PENDING_ROW}
          </Text>
        ) : null}
      </Pressable>
      <View style={styles.rowActs}>
        {task.scope_id ? (
          <Text style={styles.vault}>{VAULT_MARKER}</Text>
        ) : null}
        {act && writable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${act.label} ${task.title}`}
            onPress={() => act.run(task)}
            style={styles.headVerb}
          >
            <Text style={styles.verbText}>{act.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
