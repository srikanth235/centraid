/*! governance: allow-repo-hygiene file-size-limit — one native Tasks cover keeps the offline replica projection and its receipted interaction surface together. */
import { Feather } from "@expo/vector-icons";
import React, { memo, useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import HomeKey from "../../kit/components/HomeKey";
import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  nativeWriteOutput,
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { family, radii, useTheme } from "../../kit/theme";
import type { NativeOptimisticMutation } from "../../lib/replica/native-session";
import type { TasksScreenProps } from "../../navigation";

type TaskView = "inbox" | "today" | "upcoming" | `project:${string}`;
const day = (): string => new Date().toISOString().slice(0, 10);
// `task_id` is the primary key of schedule.task, so it is unique per row even
// while an optimistic insert is still pending.
const taskKey = (row: ReplicaRow): string => String(row.task_id);

// Every callback takes the row instead of being pre-bound per cell, so the
// screen can hand all rows one stable function set and let memo hold.
const DragTaskRow = memo(
  ({
    row,
    sectionName,
    onToggle,
    onMove,
    onReorder,
  }: {
    row: ReplicaRow;
    sectionName?: string;
    onToggle: (row: ReplicaRow) => void;
    onMove: (row: ReplicaRow) => void;
    onReorder: (row: ReplicaRow, direction: -1 | 1) => void;
  }): React.JSX.Element => {
    const { colors } = useTheme();
    const responder = useMemo(
      () =>
        PanResponder.create({
          onMoveShouldSetPanResponder: (_, gesture) =>
            Math.abs(gesture.dy) > 10 &&
            Math.abs(gesture.dy) > Math.abs(gesture.dx),
          onPanResponderRelease: (_, gesture) => {
            if (Math.abs(gesture.dy) > 24)
              onReorder(row, gesture.dy < 0 ? -1 : 1);
          },
        }),
      [onReorder, row]
    );
    return (
      <View
        {...responder.panHandlers}
        style={[
          styles.task,
          { backgroundColor: colors.bgElev, borderColor: colors.line },
        ]}
      >
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: false }}
          onPress={() => onToggle(row)}
          style={[styles.check, { borderColor: colors.accent }]}
        />
        <View style={styles.taskMain}>
          <Text style={[styles.taskTitle, { color: colors.ink }]}>
            {String(row.title ?? "Untitled task")}
          </Text>
          <Text style={[styles.meta, { color: colors.ink3 }]}>
            {row.due_at ? String(row.due_at).slice(0, 10) : "Anytime"}
            {sectionName ? ` · ${sectionName}` : ""}
            {row.recurrence_anchor === "completion"
              ? " · repeats after completion"
              : row.rrule
                ? " · repeating"
                : ""}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Move task"
          onPress={() => onMove(row)}
          style={styles.iconButton}
        >
          <Feather name="folder" size={17} color={colors.ink2} />
        </Pressable>
        <Feather name="menu" size={18} color={colors.ink3} />
      </View>
    );
  }
);
DragTaskRow.displayName = "DragTaskRow";

export default function TasksHome({
  navigation,
}: TasksScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const tasks = useReplicaQuery(
    "tasks",
    useMemo(() => ({ entity: "schedule.task" }), [])
  );
  const projects = useReplicaQuery(
    "tasks",
    useMemo(() => ({ entity: "schedule.project" }), [])
  );
  const sections = useReplicaQuery(
    "tasks",
    useMemo(() => ({ entity: "schedule.section" }), [])
  );
  const queryState = combineReplicaQueryStates([tasks, projects, sections]);
  const [view, setView] = useState<TaskView>("inbox");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState<"none" | "today" | "tomorrow">("none");
  const [repeat, setRepeat] = useState(false);
  const [completionAnchor, setCompletionAnchor] = useState(false);
  const [projectDraft, setProjectDraft] = useState("");
  const [areaDraft, setAreaDraft] = useState("");
  const [sectionDraft, setSectionDraft] = useState("");
  const [movingTask, setMovingTask] = useState<ReplicaRow>();

  const openTasks = useMemo(
    () =>
      tasks.rows
        .filter(
          (row) => row.status === "needs-action" || row.status === "in-process"
        )
        .sort(
          (a, b) =>
            Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) ||
            String(a.task_id).localeCompare(String(b.task_id))
        ),
    [tasks.rows]
  );
  const visible = useMemo(() => {
    const today = day();
    if (view === "inbox") return openTasks.filter((row) => !row.project_id);
    if (view === "today")
      return openTasks.filter(
        (row) => row.due_at && String(row.due_at).slice(0, 10) <= today
      );
    if (view === "upcoming")
      return openTasks.filter(
        (row) => row.due_at && String(row.due_at).slice(0, 10) > today
      );
    const projectId = view.slice("project:".length);
    return openTasks.filter((row) => row.project_id === projectId);
  }, [openTasks, view]);
  const activeProjectId = view.startsWith("project:")
    ? view.slice("project:".length)
    : null;

  // Stable so the row callbacks built on it are stable too.
  const write = useCallback(
    async (
      action: string,
      input: Record<string, ReplicaValue>,
      optimistic?: NativeOptimisticMutation[]
    ) => {
      if (!session) return undefined;
      try {
        const result = await session.write("tasks", {
          action,
          input,
          ...(optimistic ? { optimistic } : {}),
        });
        if (
          !surfaceWriteOutcome(result, {
            onParked: () =>
              navigation.navigate("Settings", { screen: "Approvals" }),
            queuedMessage: "This Tasks change will sync automatically.",
          })
        )
          return undefined;
        return result;
      } catch (error) {
        surfaceWriteFailure(error, "Tasks change failed");
        return undefined;
      }
    },
    [navigation, session]
  );

  const addTask = async (): Promise<void> => {
    const clean = title.trim();
    if (!clean) return;
    const dueDate = new Date();
    if (due === "tomorrow") dueDate.setDate(dueDate.getDate() + 1);
    const dueAt =
      due === "none" ? undefined : dueDate.toISOString().slice(0, 10);
    const rowId = `optimistic-${Date.now()}`;
    const result = await write(
      "add",
      {
        title: clean,
        ...(dueAt ? { due_at: dueAt } : {}),
        ...(repeat ? { rrule: "FREQ=WEEKLY" } : {}),
      },
      [
        {
          op: "upsert",
          entity: "schedule.task",
          rowId,
          values: {
            task_id: rowId,
            title: clean,
            status: "needs-action",
            due_at: dueAt ?? null,
            rrule: repeat ? "FREQ=WEEKLY" : null,
            project_id: activeProjectId,
            sort_order: visible.length,
          },
        },
      ]
    );
    const taskId = String(nativeWriteOutput(result)?.task_id ?? "");
    if (taskId && (activeProjectId || completionAnchor) && result)
      await write("organize-task", {
        task_id: taskId,
        ...(activeProjectId
          ? { project_id: activeProjectId }
          : { clear_project: true }),
        sort_order: visible.length,
        ...(completionAnchor
          ? {
              recurrence_anchor: "completion",
              recurrence_tz:
                Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            }
          : {}),
      });
    setTitle("");
  };

  const createProject = async (): Promise<void> => {
    if (!projectDraft.trim()) return;
    await write("save-project", {
      name: projectDraft.trim(),
      ...(areaDraft.trim() ? { area: areaDraft.trim() } : {}),
      sort_order: projects.rows.length,
    });
    setProjectDraft("");
    setAreaDraft("");
  };
  const createSection = async (): Promise<void> => {
    if (!activeProjectId || !sectionDraft.trim()) return;
    await write("save-section", {
      project_id: activeProjectId,
      name: sectionDraft.trim(),
      sort_order: sections.rows.filter(
        (row) => row.project_id === activeProjectId
      ).length,
    });
    setSectionDraft("");
  };

  const moveTask = useCallback((row: ReplicaRow): void => {
    setMovingTask(row);
  }, []);
  const moveTo = async (
    destination: { projectId?: string; sectionId?: string } = {}
  ): Promise<void> => {
    if (!movingTask) return;
    await write("organize-task", {
      task_id: String(movingTask.task_id),
      ...(destination.projectId
        ? {
            project_id: destination.projectId,
            ...(destination.sectionId
              ? { section_id: destination.sectionId }
              : {}),
          }
        : { clear_project: true }),
      sort_order: 0,
    });
    setMovingTask(undefined);
  };
  const reorder = useCallback(
    (row: ReplicaRow, direction: -1 | 1): void => {
      const index = visible.findIndex((item) => item.task_id === row.task_id);
      const target = visible[index + direction];
      if (!target) return;
      void write("organize-task", {
        task_id: String(row.task_id),
        ...(row.project_id
          ? {
              project_id: String(row.project_id),
              ...(row.section_id ? { section_id: String(row.section_id) } : {}),
            }
          : { clear_project: true }),
        sort_order: Number(target.sort_order ?? index + direction),
      });
    },
    [visible, write]
  );
  const completeTask = useCallback(
    (row: ReplicaRow): void => {
      void write("set-status", {
        task_id: String(row.task_id),
        status: "completed",
      });
    },
    [write]
  );
  // A map instead of a linear find per row: the row body only needs the name.
  const sectionNameById = useMemo(
    () =>
      new Map(
        sections.rows.map((section) => [
          String(section.section_id),
          typeof section.name === "string" ? section.name : undefined,
        ])
      ),
    [sections.rows]
  );
  const renderTask = useCallback(
    ({ item }: ListRenderItemInfo<ReplicaRow>): React.JSX.Element => {
      const sectionName = sectionNameById.get(String(item.section_id));
      return (
        <DragTaskRow
          row={item}
          {...(sectionName ? { sectionName } : {})}
          onToggle={completeTask}
          onMove={moveTask}
          onReorder={reorder}
        />
      );
    },
    [completeTask, moveTask, reorder, sectionNameById]
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={() => navigation.goBack()} />
        <View>
          <Text style={[styles.title, { color: colors.ink }]}>Tasks</Text>
          <Text style={[styles.meta, { color: colors.ink3 }]}>
            Inbox, projects and offline repeat rules
          </Text>
        </View>
      </View>
      <ReplicaStatusBar />
      <ReplicaStateCard
        noun="Tasks"
        connection={queryState.connection}
        error={queryState.error}
        unavailableReason={queryState.unavailableReason}
        onRetry={() =>
          void Promise.all([
            tasks.refresh(),
            projects.refresh(),
            sections.refresh(),
          ])
        }
      />
      <ScrollView horizontal contentContainerStyle={styles.chips}>
        {(["inbox", "today", "upcoming"] as const).map((key) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ selected: view === key }}
            onPress={() => setView(key)}
            style={[
              styles.chip,
              {
                backgroundColor: view === key ? colors.accent : colors.bgSunken,
              },
            ]}
          >
            <Text style={{ color: view === key ? colors.bg : colors.ink2 }}>
              {key[0]!.toUpperCase() + key.slice(1)}
            </Text>
          </Pressable>
        ))}
        {projects.rows.map((project) => {
          const key = `project:${String(project.project_id)}` as const;
          return (
            <Pressable
              key={key}
              accessibilityState={{ selected: view === key }}
              onPress={() => setView(key)}
              style={[
                styles.chip,
                {
                  backgroundColor:
                    view === key ? colors.accent : colors.bgSunken,
                },
              ]}
            >
              <Text style={{ color: view === key ? colors.bg : colors.ink2 }}>
                {String(project.name ?? "Project")}
                {project.area ? ` · ${String(project.area)}` : ""}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="New task title"
          value={title}
          placeholder="Add a task"
          placeholderTextColor={colors.ink3}
          onChangeText={setTitle}
          onSubmitEditing={() => void addTask()}
          style={[
            styles.input,
            { borderColor: colors.line, color: colors.ink },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => void addTask()}
          style={[styles.add, { backgroundColor: colors.accent }]}
        >
          <Feather name="plus" size={20} color={colors.bg} />
        </Pressable>
      </View>
      <View style={styles.options}>
        {(["none", "today", "tomorrow"] as const).map((choice) => (
          <Pressable key={choice} onPress={() => setDue(choice)}>
            <Text
              style={{ color: due === choice ? colors.accent : colors.ink3 }}
            >
              {choice}
            </Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setRepeat((current) => !current)}>
          <Text style={{ color: repeat ? colors.accent : colors.ink3 }}>
            weekly
          </Text>
        </Pressable>
        <Pressable
          disabled={!repeat}
          onPress={() => setCompletionAnchor((current) => !current)}
        >
          <Text
            style={{
              color: repeat && completionAnchor ? colors.accent : colors.ink3,
            }}
          >
            after completion
          </Text>
        </Pressable>
      </View>
      <FlatList
        data={visible}
        keyExtractor={taskKey}
        contentContainerStyle={styles.list}
        // No getItemLayout: styles.task sets padding, not a height, and the
        // task title wraps freely, so rows are 62pt only in the one-line case.
        // The list is squeezed between the composer/options above and the
        // organize block below — roughly 320pt, so ~5 of the 70pt (62 + 8 gap)
        // rows are on screen; 6 covers the first paint plus a partial row.
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={7}
        // No removeClippedSubviews: each row owns a PanResponder for
        // drag-to-reorder, and clipping detaches those touch targets on Android.
        ListEmptyComponent={
          queryState.loading ? null : (
            <Text style={[styles.empty, { color: colors.ink3 }]}>
              Nothing here yet. Changes remain available offline.
            </Text>
          )
        }
        renderItem={renderTask}
      />
      <View style={styles.organize}>
        <TextInput
          value={projectDraft}
          placeholder="New project"
          placeholderTextColor={colors.ink3}
          onChangeText={setProjectDraft}
          style={[
            styles.smallInput,
            { borderColor: colors.line, color: colors.ink },
          ]}
        />
        <TextInput
          value={areaDraft}
          placeholder="Area (optional)"
          placeholderTextColor={colors.ink3}
          onChangeText={setAreaDraft}
          style={[
            styles.smallInput,
            { borderColor: colors.line, color: colors.ink },
          ]}
        />
        <Pressable onPress={() => void createProject()}>
          <Text style={{ color: colors.accent }}>Add project</Text>
        </Pressable>
        {activeProjectId ? (
          <>
            <TextInput
              value={sectionDraft}
              placeholder="New section"
              placeholderTextColor={colors.ink3}
              onChangeText={setSectionDraft}
              style={[
                styles.smallInput,
                { borderColor: colors.line, color: colors.ink },
              ]}
            />
            <Pressable onPress={() => void createSection()}>
              <Text style={{ color: colors.accent }}>Add section</Text>
            </Pressable>
          </>
        ) : null}
      </View>
      <Modal
        visible={Boolean(movingTask)}
        transparent
        animationType="fade"
        onRequestClose={() => setMovingTask(undefined)}
      >
        <View accessibilityViewIsModal style={styles.modalBackdrop}>
          <View style={[styles.modal, { backgroundColor: colors.bgElev }]}>
            <Text style={[styles.taskTitle, { color: colors.ink }]}>
              Move task
            </Text>
            <ScrollView contentContainerStyle={styles.destinations}>
              <Pressable
                accessibilityRole="button"
                onPress={() => void moveTo()}
                style={[styles.destination, { borderColor: colors.line }]}
              >
                <Text style={{ color: colors.ink }}>Inbox</Text>
              </Pressable>
              {projects.rows.map((project) => (
                <View key={String(project.project_id)}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      void moveTo({
                        projectId: String(project.project_id),
                      })
                    }
                    style={[styles.destination, { borderColor: colors.line }]}
                  >
                    <Text style={{ color: colors.ink }}>
                      {String(project.name ?? "Project")} · Unsectioned
                    </Text>
                  </Pressable>
                  {sections.rows
                    .filter(
                      (section) => section.project_id === project.project_id
                    )
                    .map((section) => (
                      <Pressable
                        key={String(section.section_id)}
                        accessibilityRole="button"
                        onPress={() =>
                          void moveTo({
                            projectId: String(project.project_id),
                            sectionId: String(section.section_id),
                          })
                        }
                        style={[
                          styles.destination,
                          styles.sectionDestination,
                          { borderColor: colors.line },
                        ]}
                      >
                        <Text style={{ color: colors.ink2 }}>
                          {String(section.name ?? "Section")}
                        </Text>
                      </Pressable>
                    ))}
                </View>
              ))}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              onPress={() => setMovingTask(undefined)}
            >
              <Text style={{ color: colors.ink2 }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  add: {
    alignItems: "center",
    borderRadius: 12,
    justifyContent: "center",
    width: 46,
  },
  check: { borderRadius: 10, borderWidth: 2, height: 20, width: 20 },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chips: { gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  composer: { flexDirection: "row", gap: 8, paddingHorizontal: 16 },
  destination: { borderBottomWidth: 1, minHeight: 42, paddingVertical: 11 },
  destinations: { paddingBottom: 8 },
  empty: { fontFamily: family.sansRegular, padding: 28, textAlign: "center" },
  header: { alignItems: "center", flexDirection: "row", gap: 12, padding: 16 },
  iconButton: { padding: 8 },
  input: {
    borderRadius: radii.lg,
    borderWidth: 1,
    flex: 1,
    fontSize: 16,
    padding: 13,
  },
  list: { gap: 8, padding: 16, paddingBottom: 8 },
  meta: { fontFamily: family.sansRegular, fontSize: 12 },
  modal: {
    borderRadius: radii.lg,
    margin: 24,
    maxHeight: "75%",
    padding: 18,
  },
  modalBackdrop: {
    backgroundColor: "rgba(0,0,0,.4)",
    flex: 1,
    justifyContent: "center",
  },
  options: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
    padding: 12,
    paddingHorizontal: 18,
  },
  organize: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    padding: 12,
  },
  safe: { flex: 1 },
  sectionDestination: { paddingLeft: 18 },
  smallInput: { borderRadius: 8, borderWidth: 1, minWidth: 130, padding: 8 },
  task: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 12,
  },
  taskMain: { flex: 1 },
  taskTitle: { fontFamily: family.sansMedium, fontSize: 15 },
  title: { fontFamily: family.displayBold, fontSize: 28 },
});
