import React, { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, View } from "react-native";

import { sortGroups } from "@centraid/blueprints/apps/tasks/board-view";
import {
  projectRows,
  projectSectionGroups,
  projectSections,
  sectionWrite,
} from "@centraid/blueprints/apps/tasks/projects";
import { PROJECTS } from "@centraid/blueprints/apps/tasks/shelves";
import type {
  Project,
  Section,
  Task,
} from "@centraid/blueprints/apps/tasks/types";
import {
  GROUPS,
  SECTIONS,
  shelfCopy,
} from "@centraid/blueprints/apps/tasks/view-copy";
import { landedTaskId } from "@centraid/blueprints/apps/tasks/writes";

import { Text, TextInput } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import TaskRow from "./TaskRow";
import { flattenGroups } from "./tasks-groups";
import type { TasksListItem } from "./tasks-groups";
import { TASK_NAME_PLACEHOLDER } from "./tasks-seat-copy";
import type { TasksStyles } from "./TasksHome.styles";
import TasksPlaceHeader from "./TasksPlaceHeader";
import type { TasksWrite } from "./useTasks";

export interface TasksProjectProps {
  project: Project;
  sections: readonly Section[];
  tasks: readonly Task[];
  now: string;
  styles: TasksStyles;
  write: TasksWrite;
  onBack: () => void;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
}

export default function TasksProject({
  project,
  sections,
  tasks,
  now,
  styles,
  write,
  onBack,
  onToggle,
  onOpen,
}: TasksProjectProps): React.JSX.Element {
  const { colors } = useTheme();
  const [adding, setAdding] = useState<string | null>(null);
  const [sectionDraft, setSectionDraft] = useState("");

  const own = useMemo(
    () => projectSections(sections, project.project_id),
    [project.project_id, sections]
  );
  const groups = useMemo(
    () =>
      sortGroups(
        projectSectionGroups({
          sections: own,
          rows: projectRows(tasks, project.project_id),
        }),
        "manual"
      ),
    [own, project.project_id, tasks]
  );
  const items = useMemo(() => flattenGroups(groups), [groups]);

  const addTask = useCallback(
    async (title: string, sectionKey: string): Promise<void> => {
      const named = title.trim();
      setAdding(null);
      if (!named) return;
      const outcome = await write("add", { title: named });
      const taskId = landedTaskId(outcome);
      if (!taskId) return;
      const section = own.find((entry) => entry.section_id === sectionKey);
      const group = groups.find((entry) => entry.key === sectionKey);
      await write("organize-task", {
        task_id: taskId,
        sort_order: group?.rows.length ?? 0,
        project_id: project.project_id,
        ...(section ? { section_id: section.section_id } : {}),
      });
    },
    [groups, own, project.project_id, write]
  );

  const renderItem = ({ item }: { item: TasksListItem }): React.JSX.Element => {
    if (item.kind === "task") {
      return (
        <TaskRow
          task={item.task}
          now={now}
          styles={styles}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      );
    }
    const open = adding === item.group.key;
    return (
      <View>
        <View style={styles.groupHead}>
          <Text style={styles.groupLabel}>{item.group.label}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${GROUPS.addTask} · ${item.group.label}`}
            onPress={() => setAdding(open ? null : item.group.key)}
            style={styles.headVerb}
          >
            <Text style={styles.verbText}>{GROUPS.addTask}</Text>
          </Pressable>
        </View>
        {open ? (
          <TextInput
            accessibilityLabel={GROUPS.addTask}
            placeholder={TASK_NAME_PLACEHOLDER}
            placeholderTextColor={colors.textGhost}
            onSubmitEditing={(event) => {
              void addTask(event.nativeEvent.text, item.group.key);
            }}
            style={styles.searchField}
          />
        ) : null}
      </View>
    );
  };

  return (
    <>
      <TasksPlaceHeader
        title={project.name}
        backTo={shelfCopy(PROJECTS).title}
        onBack={onBack}
        styles={styles}
      />
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={
          <View style={styles.pane}>
            <TextInput
              accessibilityLabel={SECTIONS.add}
              placeholder={SECTIONS.name}
              placeholderTextColor={colors.textGhost}
              value={sectionDraft}
              onChangeText={setSectionDraft}
              style={styles.searchField}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={SECTIONS.add}
              accessibilityState={{
                disabled: sectionDraft.trim().length === 0,
              }}
              disabled={sectionDraft.trim().length === 0}
              onPress={() => {
                void write(
                  "save-section",
                  sectionWrite({
                    projectId: project.project_id,
                    name: sectionDraft,
                    sortOrder: own.length + 1,
                  })
                );
                setSectionDraft("");
              }}
              style={[
                styles.primary,
                sectionDraft.trim().length === 0
                  ? styles.primaryOff
                  : undefined,
              ]}
            >
              <Text style={styles.primaryText}>{SECTIONS.add}</Text>
            </Pressable>
          </View>
        }
      />
    </>
  );
}
