// The detail place's field list and its controls (Tasks spec §5).
//
// THE ANCHOR IS THE FIELD THIS SCREEN EXISTS FOR: two cards, each a sentence a
// member could say out loud, and the choice decides what a missed period MEANS.
// It is drawn only where the task actually repeats, because a task that runs
// once has no missed period to interpret.
//
// A read-only row keeps every control visible and disabled with the reason
// attached (`accessibilityHint`), never a press that quietly fails.

import React from "react";
import { Pressable, View } from "react-native";

import {
  EFFORT_CHOICES,
  anchorOf,
  taskFields,
} from "@centraid/blueprints/apps/tasks/detail";
import type { TaskField } from "@centraid/blueprints/apps/tasks/detail";
import type { Project, Task } from "@centraid/blueprints/apps/tasks/types";
import {
  ANCHOR_CARDS,
  GROUPS,
  PRIORITY_CHIPS,
} from "@centraid/blueprints/apps/tasks/view-copy";

import { Text, TextInput } from "../../kit/components/NativeText";
import { READ_ONLY_SOURCE_REASON } from "../../kit/replica/row-provenance";
import { useTheme } from "../../kit/theme";
import { ATTACHED_SEAT_NOTE, TAG_PLACEHOLDER } from "./tasks-seat-copy";
import type { TasksStyles } from "./TasksHome.styles";

export interface TaskDetailActs {
  onAnchor: (anchor: "scheduled" | "completion") => void;
  onPriority: (priority: number) => void;
  onEffort: (minutes: number) => void;
  onProject: (projectId: string | null) => void;
  onAddTag: (label: string) => void;
  onRemoveTag: (tagId: string) => void;
}

export interface TaskDetailFieldsProps extends TaskDetailActs {
  task: Task;
  now: string;
  projects: readonly Project[];
  projectName: string | null;
  /** The vault carrying this row, where the plane stamped one. This seat knows
   *  the vault but not who else stands in it, so the sentence stops there. */
  home: { vault: string } | null;
  writable: boolean;
  styles: TasksStyles;
}

function Chip({
  label,
  on,
  writable,
  onPress,
  styles,
}: {
  label: string;
  on: boolean;
  writable: boolean;
  onPress: () => void;
  styles: TasksStyles;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on, disabled: !writable }}
      accessibilityHint={writable ? undefined : READ_ONLY_SOURCE_REASON}
      disabled={!writable}
      onPress={onPress}
      style={[styles.chip, on ? styles.chipOn : undefined]}
    >
      <Text style={[styles.chipText, on ? styles.chipTextOn : undefined]}>
        {label}
      </Text>
    </Pressable>
  );
}

function AnchorCards(props: TaskDetailFieldsProps): React.JSX.Element {
  const { styles, task, writable } = props;
  const chosen = anchorOf(task);
  return (
    <View style={styles.cards}>
      {ANCHOR_CARDS.map((card) => (
        <Pressable
          key={card.value}
          accessibilityRole="button"
          accessibilityLabel={card.head}
          accessibilityState={{
            selected: chosen === card.value,
            disabled: !writable,
          }}
          accessibilityHint={writable ? undefined : READ_ONLY_SOURCE_REASON}
          disabled={!writable}
          onPress={() => props.onAnchor(card.value)}
          style={[
            styles.card,
            chosen === card.value ? styles.cardOn : undefined,
          ]}
        >
          <Text style={styles.cardHead}>{card.head}</Text>
          <Text style={styles.cardBody}>{card.body}</Text>
          <Text style={styles.cardBody}>{card.tag}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function FieldControl({
  field,
  ...props
}: TaskDetailFieldsProps & { field: TaskField }): React.JSX.Element | null {
  const { colors } = useTheme();
  const { styles, task, writable } = props;
  if (field.key === "anchor") return <AnchorCards {...props} />;
  if (field.key === "priority") {
    return (
      <View style={styles.chipRow}>
        {PRIORITY_CHIPS.map((label, level) => (
          <Chip
            key={label}
            label={label}
            on={(task.priority ?? 0) === level}
            writable={writable}
            onPress={() => props.onPriority(level)}
            styles={styles}
          />
        ))}
      </View>
    );
  }
  if (field.key === "effort") {
    return (
      <View style={styles.chipRow}>
        {EFFORT_CHOICES.map((choice) => (
          <Chip
            key={choice.label}
            label={choice.label}
            on={(task.effort_min ?? 0) === choice.minutes}
            writable={writable}
            onPress={() => props.onEffort(choice.minutes)}
            styles={styles}
          />
        ))}
      </View>
    );
  }
  if (field.key === "project") {
    return (
      <View style={styles.chipRow}>
        <Chip
          label={GROUPS.inbox}
          on={!task.project_id}
          writable={writable}
          onPress={() => props.onProject(null)}
          styles={styles}
        />
        {props.projects.map((project) => (
          <Chip
            key={project.project_id}
            label={project.name}
            on={task.project_id === project.project_id}
            writable={writable}
            onPress={() => props.onProject(project.project_id)}
            styles={styles}
          />
        ))}
      </View>
    );
  }
  if (field.key === "tags") {
    return (
      <View style={styles.chipRow}>
        {(task.tags ?? []).map((tag) => (
          <Chip
            key={tag.tag_id}
            label={tag.label}
            on
            writable={writable}
            onPress={() => props.onRemoveTag(tag.tag_id)}
            styles={styles}
          />
        ))}
        {writable ? (
          <TextInput
            accessibilityLabel={TAG_PLACEHOLDER}
            placeholder={TAG_PLACEHOLDER}
            placeholderTextColor={colors.textGhost}
            onSubmitEditing={(event) => {
              const label = event.nativeEvent.text.trim();
              if (label) props.onAddTag(label);
            }}
            style={styles.searchField}
          />
        ) : null}
      </View>
    );
  }
  if (field.key === "attached") {
    return (
      <View style={styles.chipRow}>
        {(task.attachments ?? []).map((attachment) => (
          <Text
            key={String(attachment.attachment_id)}
            style={styles.fieldValue}
          >
            {String(attachment.title ?? "")}
          </Text>
        ))}
      </View>
    );
  }
  return null;
}

export default function TaskDetailFields(
  props: TaskDetailFieldsProps
): React.JSX.Element {
  const { styles } = props;
  return (
    <View>
      {taskFields({
        task: props.task,
        now: props.now,
        projectName: props.projectName,
        home: props.home,
      }).map((field) => (
        <View key={field.key} style={styles.fieldRow}>
          <Text style={styles.fieldKey}>{field.label}</Text>
          <View style={styles.fieldBody}>
            {field.value ? (
              <Text style={styles.fieldValue}>{field.value}</Text>
            ) : null}
            <FieldControl field={field} {...props} />
            {field.notes.map((note) => (
              <Text key={note} style={styles.fieldNote}>
                {note}
              </Text>
            ))}
            {field.key === "attached" ? (
              <Text style={styles.fieldNote}>{ATTACHED_SEAT_NOTE}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}
