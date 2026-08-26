// Tasks on the phone (Tasks spec §1–§7; #834). The claimed band's four
// destinations all live on this ONE screen — the navigator gives Tasks one
// route. THE ARITHMETIC IS THE WEB APP'S: groups, rules, strings come from
// `@centraid/blueprints/apps/tasks/*`; this file only draws and dispatches.
// A FLATLIST, NOT A SCROLLVIEW (no upper bound on rows).
// FILING IS A LONG-PRESS AND A DESTINATION; the row's own `sort_order` is
// carried through `organize-task`, not reset behind manual order.

import React, { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";

import { readPendingOverlay } from "@centraid/blueprints/apps/_shared/pending-overlay";
import {
  dueLabel,
  metaParts,
  weekdayName,
} from "@centraid/blueprints/apps/tasks/format";
import {
  inboxGroup,
  isOpen,
  todayGroups,
  upcomingGroups,
} from "@centraid/blueprints/apps/tasks/logic";
import type { Task, TaskGroup } from "@centraid/blueprints/apps/tasks/types";
import {
  DAY_ONE,
  GROUPS,
  PENDING_ROW,
  QUICK_ADD,
  TODAY_DONE,
  VAULT_MARKER,
} from "@centraid/blueprints/apps/tasks/view-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useTheme } from "../../kit/theme";
import type { TasksScreenProps as TasksRouteProps } from "../../navigation";
import { TASKS_MORE_ROWS } from "./tasks-band";
import type { TasksBandDestinationKey } from "./tasks-band";
import { makeTasksStyles } from "./TasksHome.styles";
import TasksScreen from "./TasksScreen";
import { useTasks, useTasksWrite } from "./useTasks";

/** One flat item the list draws: a group header, or a task under it —
 *  virtualization must reach the rows either way. */
type Item =
  | { kind: "header"; key: string; group: TaskGroup }
  | { kind: "task"; key: string; task: Task; child?: boolean };

function flatten(groups: readonly TaskGroup[]): Item[] {
  return groups.flatMap((group) => [
    { kind: "header" as const, key: `h:${group.key}`, group },
    ...group.rows.flatMap((task) => [
      { kind: "task" as const, key: task.task_id, task },
      ...(task.children ?? []).map((child) => ({
        kind: "task" as const,
        key: child.task_id,
        task: child,
        child: true,
      })),
    ]),
  ]);
}

export default function TasksHome({
  navigation,
}: TasksRouteProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeTasksStyles(colors), [colors]);
  const board = useTasks();
  const write = useTasksWrite(navigation);
  const [destination, setDestination] =
    useState<TasksBandDestinationKey>("today");
  // ONE CLOCK PER MOUNT, so headers and rows cannot straddle midnight; the
  // setter is unused by design (a mid-scroll day flip would reshuffle rows).
  const [now, setNow] = useState(() => new Date().toISOString());
  const [draft, setDraft] = useState("");
  /** The task a long-press picked up, waiting for somewhere to land. */
  const [moving, setMoving] = useState<Task | null>(null);

  const projectName = useCallback(
    (id: string | null | undefined): string | null =>
      board.projects.find((project) => project.project_id === id)?.name ?? null,
    [board.projects]
  );

  const groups = useMemo((): TaskGroup[] => {
    if (destination === "upcoming")
      return upcomingGroups(board.tasks, now, weekdayName);
    if (destination === "inbox") {
      const group = inboxGroup(board.tasks);
      return group.rows.length > 0 ? [group] : [];
    }
    if (destination === "projects" || destination === "more") return [];
    return todayGroups(board.tasks, now);
  }, [board.tasks, destination, now]);

  const items = useMemo(() => flatten(groups), [groups]);

  const complete = useCallback(
    (task: Task) => {
      void write(
        "set-status",
        { task_id: task.task_id, status: "completed" },
        task.scope_id
      );
    },
    [write]
  );

  const capture = useCallback(() => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    void write("add", {
      title,
      ...(destination === "today" ? { due_at: now.slice(0, 10) } : {}),
    });
  }, [destination, draft, now, write]);

  /** File the picked-up task, preserving its own manual order. */
  const fileInto = useCallback(
    (projectId: string) => {
      const task = moving;
      if (!task) return;
      setMoving(null);
      void write(
        "organize-task",
        {
          task_id: task.task_id,
          sort_order: task.sort_order ?? 0,
          project_id: projectId,
        },
        task.scope_id
      );
    },
    [moving, write]
  );

  // Pull-to-refresh re-reads the clock too: after midnight, "today" changed.
  const handleRefresh = useCallback(async (): Promise<void> => {
    setNow(new Date().toISOString());
    await board.refresh();
  }, [board]);

  // Explicit void-discard: RefreshControl neither awaits nor catches, so an
  // async rejection would be unobservable.
  const onRefresh = useCallback((): void => {
    void handleRefresh();
  }, [handleRefresh]);

  const moveAllToToday = useCallback(
    (rows: readonly Task[]) => {
      for (const row of rows) {
        void write(
          "edit",
          { task_id: row.task_id, due_at: now.slice(0, 10) },
          row.scope_id
        );
      }
    },
    [now, write]
  );

  const renderItem = useCallback(
    ({ item }: { item: Item }): React.JSX.Element => {
      if (item.kind === "header") {
        return (
          <View style={styles.groupHead}>
            <Text
              style={[
                styles.groupLabel,
                item.group.attention ? styles.groupLabelAttention : undefined,
              ]}
            >
              {item.group.label}
            </Text>
            {item.group.meta ? (
              <Text style={styles.num}>{item.group.meta}</Text>
            ) : null}
            {item.group.attention ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={GROUPS.moveAll}
                onPress={() => moveAllToToday(item.group.rows)}
                style={styles.headVerb}
              >
                <Text style={styles.verbText}>{GROUPS.moveAll}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      }

      const { task } = item;
      // The pending marker is drawn INLINE: one unsettled row in one app is
      // not yet kit vocabulary.
      const pending = readPendingOverlay(
        task as unknown as Record<string, unknown>
      );
      const done = task.status === "completed" || task.status === "cancelled";
      const project = projectName(task.project_id);
      const meta =
        metaParts({
          task,
          now,
          ...(project ? { projectName: project } : {}),
        })
          .map((part) => part.text)
          .join(" · ") ||
        (dueLabel(task.due_at, now) ?? "");
      return (
        <View
          style={[
            styles.rowWrap,
            item.child ? styles.rowChild : undefined,
            pending ? styles.rowPending : undefined,
            moving?.task_id === task.task_id ? styles.rowPicked : undefined,
          ]}
        >
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={task.title}
            accessibilityState={{ checked: done }}
            onPress={() => complete(task)}
            style={styles.box}
          >
            {done ? <Icon name="Check" size={14} color={colors.text} /> : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={task.title}
            accessibilityState={{ selected: moving?.task_id === task.task_id }}
            onLongPress={() => setMoving(task)}
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
          {task.scope_id ? (
            <Text style={styles.vault}>{VAULT_MARKER}</Text>
          ) : null}
        </View>
      );
    },
    [colors.text, complete, moveAllToToday, moving, now, projectName, styles]
  );

  const body = ((): React.JSX.Element => {
    if (destination === "projects") {
      return (
        <View style={styles.pane}>
          {board.projects.map((project) => (
            <View key={project.project_id} style={styles.projectRow}>
              <Text style={styles.title}>{project.name}</Text>
              <Text style={styles.num}>
                {
                  board.tasks.filter(
                    (task) =>
                      task.project_id === project.project_id && isOpen(task)
                  ).length
                }
              </Text>
              {moving ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={project.name}
                  onPress={() => fileInto(project.project_id)}
                  style={styles.headVerb}
                >
                  <Text style={styles.verbText}>{GROUPS.addTask}</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={project.name}
                  onPress={() => {
                    void write("save-section", {
                      project_id: project.project_id,
                      name: GROUPS.today,
                    });
                  }}
                  style={styles.headVerb}
                >
                  <Text style={styles.verbText}>{GROUPS.today}</Text>
                </Pressable>
              )}
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={GROUPS.addTask}
            onPress={() => {
              void write("save-project", { name: GROUPS.inbox });
            }}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>{GROUPS.addTask}</Text>
          </Pressable>
        </View>
      );
    }

    if (destination === "more") {
      return (
        <View style={styles.pane}>
          {TASKS_MORE_ROWS.map((row) => (
            <View key={String(row.shelf)} style={styles.projectRow}>
              <Icon name={row.icon} size={16} color={colors.textSoft} />
              <Text style={styles.title}>{row.label}</Text>
              {row.meta ? <Text style={styles.num}>{row.meta}</Text> : null}
            </View>
          ))}
        </View>
      );
    }

    return (
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {board.tasks.length === 0 ? DAY_ONE : TODAY_DONE}
            </Text>
          </View>
        }
        contentContainerStyle={styles.listContent}
        refreshing={board.loading}
        onRefresh={onRefresh}
      />
    );
  })();

  return (
    <TasksScreen
      current={destination}
      onDestination={setDestination}
      onHome={() => navigation.navigate("Home")}
    >
      <ReplicaStatusBar />
      {body}
      {/* Capture at the foot: one field + one filled control; it files where
          the member is looking. */}
      <View style={styles.capture}>
        <TextInput
          accessibilityLabel={QUICK_ADD.add}
          placeholder={QUICK_ADD.touchPlaceholder}
          placeholderTextColor={colors.textGhost}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={capture}
          style={styles.captureField}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={QUICK_ADD.add}
          accessibilityState={{ disabled: draft.trim().length === 0 }}
          disabled={draft.trim().length === 0}
          onPress={capture}
          style={[
            styles.primary,
            draft.trim().length === 0 ? styles.primaryOff : undefined,
          ]}
        >
          <Text style={styles.primaryText}>{QUICK_ADD.add}</Text>
        </Pressable>
      </View>
    </TasksScreen>
  );
}
