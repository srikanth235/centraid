// Tasks on the phone (Tasks spec §1–§7; #834). EVERY destination — the four
// band places, the six lenses behind More, the detail place — is a value this
// file switches on (`tasks-places.ts`); the navigator gives Tasks ONE route.
// THE ARITHMETIC IS THE WEB APP'S: groups, rules and strings come from
// `@centraid/blueprints/apps/tasks/*`; this file draws and dispatches.
// A FLATLIST, NOT A SCROLLVIEW (no upper bound on rows).
// FILING IS A LONG-PRESS AND A DESTINATION; the row's own `sort_order` is
// carried through `organize-task`, not reset behind manual order.

import React, { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, View } from "react-native";

import { isOpen } from "@centraid/blueprints/apps/tasks/logic";
import { allowsQuickAdd } from "@centraid/blueprints/apps/tasks/shelves";
import type { Task } from "@centraid/blueprints/apps/tasks/types";
import {
  DAY_ONE,
  GROUPS,
  QUICK_ADD,
  TODAY_DONE,
} from "@centraid/blueprints/apps/tasks/view-copy";

import { Text, TextInput } from "../../kit/components/NativeText";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  READ_ONLY_SOURCE_REASON,
  rowCanWrite,
} from "../../kit/replica/row-provenance";
import { useTheme } from "../../kit/theme";
import type { TasksScreenProps as TasksRouteProps } from "../../navigation";
import TaskDetail from "./TaskDetail";
import TaskRow, { isClosed } from "./TaskRow";
import { TASKS_MORE_LABEL } from "./tasks-band";
import { findTask, flattenGroups, groupsFor } from "./tasks-groups";
import type { TasksListItem } from "./tasks-groups";
import { bandKeyFor, placeTitle, shelfForPlace } from "./tasks-places";
import type { TasksPlaceKey } from "./tasks-places";
import { logbookShown } from "./tasks-seat-copy";
import TasksCatchUp from "./TasksCatchUp";
import { makeTasksStyles } from "./TasksHome.styles";
import TasksMoreSheet from "./TasksMoreSheet";
import TasksPlaceHeader from "./TasksPlaceHeader";
import TasksReminders from "./TasksReminders";
import TasksScreen from "./TasksScreen";
import TasksSearch from "./TasksSearch";
import { useTasks, useTasksWrite } from "./useTasks";

export default function TasksHome({
  navigation,
}: TasksRouteProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeTasksStyles(colors), [colors]);
  const board = useTasks();
  const write = useTasksWrite(navigation);
  const [place, setPlace] = useState<TasksPlaceKey>("today");
  /** Beside the destination, not instead of it: closing returns to the row. */
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // ONE CLOCK PER MOUNT, so headers and rows cannot straddle midnight.
  const [now, setNow] = useState(() => new Date().toISOString());
  const [draft, setDraft] = useState("");
  /** The task a long-press picked up, waiting for somewhere to land. */
  const [moving, setMoving] = useState<Task | null>(null);

  const projectName = useCallback(
    (id: string | null | undefined): string | null =>
      board.projects.find((project) => project.project_id === id)?.name ?? null,
    [board.projects]
  );

  const groups = useMemo(
    () =>
      groupsFor({
        place,
        tasks: board.tasks,
        now,
        projectName: (id) => projectName(id) ?? GROUPS.inbox,
      }),
    [board.tasks, now, place, projectName]
  );

  const items = useMemo(() => (groups ? flattenGroups(groups) : []), [groups]);

  const readOnly = useMemo(() => {
    const rows = items.flatMap((item) =>
      item.kind === "task" ? [item.task] : []
    );
    return rows.length > 0 && rows.every((task) => !rowCanWrite(task));
  }, [items]);

  const toggle = useCallback(
    (task: Task) => {
      if (!rowCanWrite(task)) return;
      void write(
        "set-status",
        {
          task_id: task.task_id,
          status: isClosed(task) ? "needs-action" : "completed",
        },
        task.scope_id
      );
    },
    [write]
  );

  const openTask = useCallback((task: Task) => setOpenTaskId(task.task_id), []);

  const capture = useCallback(() => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    void write("add", {
      title,
      ...(place === "today" ? { due_at: now.slice(0, 10) } : {}),
    });
  }, [draft, now, place, write]);

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

  // RefreshControl neither awaits nor catches; a rejection would be unseen.
  const onRefresh = useCallback((): void => {
    void handleRefresh();
  }, [handleRefresh]);

  const moveAllToToday = useCallback(
    (rows: readonly Task[]) => {
      for (const row of rows) {
        if (!rowCanWrite(row)) continue;
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
    ({ item }: { item: TasksListItem }): React.JSX.Element => {
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
            {/* Withheld where no row could take it. */}
            {item.group.attention &&
            item.group.rows.some((row) => rowCanWrite(row)) ? (
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
      return (
        <TaskRow
          task={item.task}
          now={now}
          styles={styles}
          projectName={projectName(item.task.project_id)}
          child={item.child === true}
          picked={moving?.task_id === item.task.task_id}
          onToggle={toggle}
          onOpen={openTask}
          onPickUp={setMoving}
        />
      );
    },
    [moveAllToToday, moving, now, openTask, projectName, styles, toggle]
  );

  const projectsPane = (
    <View style={styles.pane}>
      {board.projects.map((project) => (
        <View key={project.project_id} style={styles.projectRow}>
          <Text style={styles.title}>{project.name}</Text>
          <Text style={styles.num}>
            {
              board.tasks.filter(
                (task) => task.project_id === project.project_id && isOpen(task)
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

  const rowsList = (
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
      // The Logbook here has no denominator; the foot says so.
      ListFooterComponent={
        place === "logbook" ? (
          <Text style={styles.num}>
            {logbookShown(items.filter((item) => item.kind === "task").length)}
          </Text>
        ) : null
      }
      contentContainerStyle={styles.listContent}
      refreshing={board.loading}
      onRefresh={onRefresh}
    />
  );

  const placeBody = ((): React.JSX.Element => {
    if (place === "projects") return projectsPane;
    if (place === "more")
      return <TasksMoreSheet styles={styles} onSelect={setPlace} />;
    if (place === "search")
      return (
        <TasksSearch
          now={now}
          styles={styles}
          onToggle={toggle}
          onOpen={openTask}
        />
      );
    if (place === "reentry")
      return (
        <TasksCatchUp
          tasks={board.tasks}
          now={now}
          styles={styles}
          write={write}
          onToggle={toggle}
          onOpen={openTask}
        />
      );
    if (place === "notify")
      return (
        <TasksReminders
          tasks={board.tasks}
          now={now}
          styles={styles}
          onToggle={toggle}
          onOpen={openTask}
        />
      );
    return rowsList;
  })();

  const openRow = findTask(board.tasks, openTaskId);
  const behindMore = bandKeyFor(place) === "more" && place !== "more";
  const quickAdd =
    !openRow &&
    allowsQuickAdd(shelfForPlace(place) ?? null) &&
    place !== "more";

  const body = openRow ? (
    <TaskDetail
      task={openRow}
      now={now}
      projects={board.projects}
      styles={styles}
      backTo={placeTitle(place)}
      onBack={() => setOpenTaskId(null)}
      onOpen={openTask}
      write={write}
    />
  ) : (
    <>
      {behindMore ? (
        <TasksPlaceHeader
          title={placeTitle(place)}
          backTo={TASKS_MORE_LABEL}
          onBack={() => setPlace("more")}
          styles={styles}
        />
      ) : null}
      {placeBody}
    </>
  );

  return (
    <TasksScreen
      current={bandKeyFor(place)}
      onDestination={(key) => {
        setOpenTaskId(null);
        setPlace(key);
      }}
      onHome={() => navigation.navigate("Home")}
    >
      <ReplicaStatusBar />
      {readOnly ? (
        <Text style={styles.readOnly}>{READ_ONLY_SOURCE_REASON}</Text>
      ) : null}
      {body}
      {/* Capture at the foot: one field + one filled control; it files where
          the member is looking. */}
      {quickAdd ? (
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
      ) : null}
    </TasksScreen>
  );
}
