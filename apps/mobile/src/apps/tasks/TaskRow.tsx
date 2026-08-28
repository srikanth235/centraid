// One task row, drawn the same way wherever rows appear (Tasks spec §5).
//
// THREE GESTURES, THREE MEANINGS: the box completes, the body OPENS the task's
// detail place, and a long press picks the row up to file it. A read-only row
// keeps all three affordances visible and attaches the reason instead of
// failing on press.

import React from "react";
import { Pressable, View } from "react-native";

import { readPendingOverlay } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { dueLabel, metaParts } from "@centraid/blueprints/apps/tasks/format";
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
}: TaskRowProps): React.JSX.Element {
  const { colors } = useTheme();
  // The pending marker is drawn INLINE: one unsettled row in one app is not
  // yet kit vocabulary.
  const pending = readPendingOverlay(
    task as unknown as Record<string, unknown>
  );
  const done = isClosed(task);
  const writable = rowCanWrite(task);
  const meta =
    metaParts({
      task,
      now,
      ...(projectName ? { projectName } : {}),
    })
      .map((part) => part.text)
      .join(" · ") ||
    (dueLabel(task.due_at, now) ?? "");

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
        <Text
          numberOfLines={1}
          style={[styles.title, done ? styles.titleDone : undefined]}
        >
          {task.title}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={styles.num}>
            {meta}
          </Text>
        ) : null}
        {pending ? (
          <Text numberOfLines={1} style={styles.pendingWords}>
            {PENDING_ROW}
          </Text>
        ) : null}
      </Pressable>
      {task.scope_id ? <Text style={styles.vault}>{VAULT_MARKER}</Text> : null}
    </View>
  );
}
