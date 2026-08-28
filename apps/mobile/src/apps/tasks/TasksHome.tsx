// Tasks on the phone (Tasks spec §1–§7; #834). EVERY destination — the four
// band places, the six lenses behind More, the detail place, one project — is a
// value this file switches on (`tasks-places.ts`); the navigator gives Tasks
// ONE route.
// THE ARITHMETIC IS THE WEB APP'S: groups, rules and strings come from
// `@centraid/blueprints/apps/tasks/*`; this file draws and dispatches.
// FILING IS A LONG-PRESS AND A DESTINATION; the row's own `sort_order` is
// carried through `organize-task`, not reset behind manual order.
// A CHECK-OFF LANDS ON THE ONE STATUS LINE with Undo, never a toast.

import React, { useCallback, useMemo, useState } from "react";

import {
  lensedRows,
  nextSort,
  sortGroups,
  toggleLens,
  TASKS_SCOPE,
} from "@centraid/blueprints/apps/tasks/board-view";
import type {
  TasksLensKey,
  TasksSortKey,
} from "@centraid/blueprints/apps/tasks/board-view";
import { openCountByProject } from "@centraid/blueprints/apps/tasks/projects";
import {
  QUICK_ADD_EMPTY,
  quickAddFiling,
  quickAddInput,
  quickAddReady,
} from "@centraid/blueprints/apps/tasks/quick-add";
import type { QuickAddDraft } from "@centraid/blueprints/apps/tasks/quick-add";
import {
  allowsQuickAdd,
  showsBoard,
} from "@centraid/blueprints/apps/tasks/shelves";
import type { Project, Task } from "@centraid/blueprints/apps/tasks/types";
import {
  DONE,
  GROUPS,
  UNDO,
  shelfCopy,
} from "@centraid/blueprints/apps/tasks/view-copy";
import { landedTaskId } from "@centraid/blueprints/apps/tasks/writes";

import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  READ_ONLY_SOURCE_REASON,
  rowCanWrite,
} from "../../kit/replica/row-provenance";
import { useTheme } from "../../kit/theme";
import type { TasksScreenProps as TasksRouteProps } from "../../navigation";
import TaskDetail from "./TaskDetail";
import { isClosed } from "./TaskRow";
import { TASKS_MORE_LABEL } from "./tasks-band";
import {
  findTask,
  flattenGroups,
  groupsFor,
  windowItems,
} from "./tasks-groups";
import { bandKeyFor, placeTitle, shelfForPlace } from "./tasks-places";
import type { TasksPlaceKey } from "./tasks-places";
import TasksCatchUp from "./TasksCatchUp";
import TasksDenied from "./TasksDenied";
import { makeTasksStyles } from "./TasksHome.styles";
import TasksMoreSheet from "./TasksMoreSheet";
import TasksPlaceHeader from "./TasksPlaceHeader";
import TasksProject from "./TasksProject";
import TasksProjects from "./TasksProjects";
import TasksQuickAdd from "./TasksQuickAdd";
import TasksReminders from "./TasksReminders";
import TasksRows from "./TasksRows";
import TasksScreen from "./TasksScreen";
import TasksSearch from "./TasksSearch";
import TasksToolbar from "./TasksToolbar";
import { useTasks, useTasksWrite } from "./useTasks";

const WINDOW_STEP = 50;

export default function TasksHome({
  navigation,
}: TasksRouteProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeTasksStyles(colors), [colors]);
  const board = useTasks();
  const replica = useReplica();
  const write = useTasksWrite(navigation);
  const [place, setPlace] = useState<TasksPlaceKey>("today");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  // ONE CLOCK PER MOUNT, so headers and rows cannot straddle midnight.
  const [now, setNow] = useState(() => new Date().toISOString());
  const [draft, setDraft] = useState<QuickAddDraft>(QUICK_ADD_EMPTY);
  const [lenses, setLenses] = useState<readonly TasksLensKey[]>([]);
  const [sort, setSort] = useState<TasksSortKey>("priority");
  const [limit, setLimit] = useState(WINDOW_STEP);
  /** The task a long-press picked up, waiting for somewhere to land. */
  const [moving, setMoving] = useState<Task | null>(null);

  const scopes = useMemo(
    () =>
      (replica.scopes ?? []).map((scope) => ({
        id: scope.vaultId,
        label: scope.label,
        canWrite: scope.canWrite,
      })),
    [replica.scopes]
  );

  const projectName = useCallback(
    (id: string | null | undefined): string | null =>
      board.projects.find((project) => project.project_id === id)?.name ?? null,
    [board.projects]
  );

  const shelf = shelfForPlace(place) ?? null;
  // THE TOOLBAR REACHES ONLY WHERE IT IS DRAWN: off the board a lens is a
  // hidden filter, and the sort would overrule the Logbook's own order.
  const rows = useMemo(
    () => (showsBoard(shelf) ? lensedRows(board.tasks, lenses) : board.tasks),
    [board.tasks, lenses, shelf]
  );

  const groups = useMemo(() => {
    const found = groupsFor({
      place,
      tasks: rows,
      now,
      projectName: (id) => projectName(id) ?? GROUPS.inbox,
    });
    if (!found) return null;
    return showsBoard(shelf) ? sortGroups(found, sort) : found;
  }, [now, place, projectName, rows, shelf, sort]);

  const items = useMemo(() => (groups ? flattenGroups(groups) : []), [groups]);
  const shownItems = useMemo(() => windowItems(items, limit), [items, limit]);

  const readOnly = useMemo(() => {
    const held = items.flatMap((item) =>
      item.kind === "task" ? [item.task] : []
    );
    return held.length > 0 && held.every((task) => !rowCanWrite(task));
  }, [items]);

  const setStatus = useCallback(
    (task: Task, status: Task["status"]) => {
      void write(
        "set-status",
        { task_id: task.task_id, status },
        task.scope_id
      );
    },
    [write]
  );

  const toggle = useCallback(
    (task: Task) => {
      if (!rowCanWrite(task)) return;
      if (isClosed(task)) {
        setStatus(task, "needs-action");
        return;
      }
      setStatus(task, "completed");
      // Undo IS reopening — the same door the box offers, said in words.
      postStatus(DONE, {
        action: { label: UNDO, run: () => setStatus(task, "needs-action") },
      });
    },
    [setStatus]
  );

  const openTask = useCallback((task: Task) => setOpenTaskId(task.task_id), []);

  const capture = useCallback(async (): Promise<void> => {
    if (!quickAddReady(draft)) return;
    const filed = draft;
    setDraft(QUICK_ADD_EMPTY);
    const outcome = await write(
      "add",
      quickAddInput(filed, now),
      filed.scopeId
    );
    const taskId = landedTaskId(outcome);
    const filing = taskId ? quickAddFiling(filed, taskId) : null;
    if (filing) await write("organize-task", filing, filed.scopeId);
  }, [draft, now, write]);

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

  // After midnight, "today" changed: a refresh re-reads the clock too.
  const handleRefresh = useCallback(async (): Promise<void> => {
    setNow(new Date().toISOString());
    await board.refresh();
  }, [board]);

  // RefreshControl neither awaits nor catches; a rejection would be unseen.
  const onRefresh = useCallback((): void => {
    void handleRefresh();
  }, [handleRefresh]);

  const moveAllToToday = useCallback(
    (batch: readonly Task[]) => {
      for (const row of batch) {
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

  /** The Inbox's ONE gesture per undecided task; elsewhere the long-press. */
  const inboxAct = useMemo(
    () =>
      place === "inbox"
        ? {
            label: GROUPS.file,
            run: (task: Task) => {
              setMoving(task);
              setPlace("projects");
            },
          }
        : undefined,
    [place]
  );

  const boardPlace = groups !== null && showsBoard(shelf);

  const rowsList = (
    <TasksRows
      place={place}
      items={shownItems.items}
      shown={shownItems.shown}
      total={shownItems.total}
      now={now}
      styles={styles}
      loading={board.loading}
      dayOne={board.tasks.length === 0}
      moving={moving}
      {...(inboxAct ? { act: inboxAct } : {})}
      projectName={projectName}
      onToggle={toggle}
      onOpen={openTask}
      onPickUp={setMoving}
      onMoveAll={moveAllToToday}
      onShowMore={() => setLimit(limit + WINDOW_STEP)}
      onRefresh={onRefresh}
    />
  );

  const openProject: Project | undefined = board.projects.find(
    (project) => project.project_id === openProjectId
  );

  const projectsPane = openProject ? (
    <TasksProject
      project={openProject}
      sections={board.sections}
      tasks={board.tasks}
      now={now}
      styles={styles}
      write={write}
      onBack={() => setOpenProjectId(null)}
      onToggle={toggle}
      onOpen={openTask}
    />
  ) : (
    <TasksProjects
      projects={board.projects}
      counts={openCountByProject(board.tasks)}
      scopes={scopes}
      filing={moving !== null}
      styles={styles}
      onOpen={setOpenProjectId}
      onFile={fileInto}
      onCreate={(input, scopeId) => {
        void write("save-project", input, scopeId);
      }}
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
    !openRow && !openProject && allowsQuickAdd(shelf) && place !== "more";
  const refusal = board.error && board.tasks.length === 0 ? board.error : null;

  const body = refusal ? (
    <TasksDenied
      receipt={refusal}
      scope={TASKS_SCOPE}
      when={now.slice(0, 16).replace("T", " ")}
      styles={styles}
    />
  ) : openRow ? (
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
      {boardPlace ? (
        <TasksToolbar
          count={shownItems.total}
          unit={shelfCopy(shelf).unit}
          lenses={lenses}
          sort={sort}
          styles={styles}
          onLens={(key) => setLenses(toggleLens(lenses, key))}
          onSort={() => setSort(nextSort(sort))}
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
        setOpenProjectId(null);
        setPlace(key);
      }}
      onHome={() => navigation.navigate("Home")}
    >
      <ReplicaStatusBar />
      {readOnly ? (
        <Text style={styles.readOnly}>{READ_ONLY_SOURCE_REASON}</Text>
      ) : null}
      {body}
      {quickAdd && !refusal ? (
        <TasksQuickAdd
          draft={draft}
          projects={board.projects}
          scopes={scopes}
          styles={styles}
          onDraft={setDraft}
          onAdd={() => void capture()}
        />
      ) : null}
    </TasksScreen>
  );
}
