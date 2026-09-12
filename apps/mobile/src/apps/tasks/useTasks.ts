// Tasks read layer (#834): the board projected from this phone's own copy of
// the vault, page by page (#996 wave 4b); board arithmetic is imported from the
// blueprint logic, never restated here. Rows carry their fields, never an
// invented recurrence count.

import { useCallback, useMemo } from "react";

import { nestTaskFamilies } from "@centraid/blueprints/apps/tasks/logic";
import type {
  Project,
  Section,
  Task,
} from "@centraid/blueprints/apps/tasks/types";
import type { ReplicaValue } from "@centraid/client/replica/native";
import type { PageQuery } from "@centraid/core/page";

import { combineReplicaQueryStates } from "../../kit/hooks/replica-query-state";
import type { ReplicaQueryState } from "../../kit/hooks/replica-query-state";
import { useSeatPages } from "../../kit/hooks/useSeatPages";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { TasksScreenProps } from "../../navigation";

const APP_ID = "tasks";

/*
 * THE BOARD'S THREE READS, AS PAGES OVER THIS PHONE'S OWN COPY (#996 wave 4b).
 *
 * All three used to be the truncation flag — "give me the entity and
 * whatever window you have", which was 1,000 rows nobody chose. A member with
 * more than a thousand tasks got a board that was silently missing the rest,
 * and the board arithmetic below (`nestTaskFamilies`) ran over the fragment as
 * if it were the set.
 *
 * They are walks rather than single pages because all three ARE the screen: the
 * board nests families across its whole set, so a page boundary in the middle
 * of a family would orphan children. `readPages` states where it stops and
 * throws there, which is the fact the flag hid.
 *
 * `from` names the physical table because the same statement runs on the seat's
 * file and on the gateway's paged door for a seat holding none (W4-D2).
 */

/** Every column the board and its rows read; the blueprint's own projection. */
const TASK_COLUMNS =
  "task_id, parent_task_id, project_id, section_id, status, title, " +
  "description, priority, due_at, completed_at, effort_min, rrule, tz, " +
  "remind_before_min, recurrence_anchor, series_id, sort_order, created_at, " +
  "updated_at";

const TASKS: PageQuery = {
  name: "phone.tasks.board",
  select: TASK_COLUMNS,
  from: "schedule_task",
  where: "deleted_at IS NULL",
  order: { sortColumn: "created_at", pkColumn: "task_id", descending: true },
};

const PROJECTS: PageQuery = {
  name: "phone.tasks.projects",
  select: "project_id, name, area, color, sort_order",
  from: "schedule_project",
  where: "archived_at IS NULL",
  order: {
    sortColumn: "sort_order",
    pkColumn: "project_id",
    descending: false,
  },
};

const SECTIONS: PageQuery = {
  name: "phone.tasks.sections",
  select: "section_id, project_id, name, sort_order",
  from: "schedule_section",
  order: {
    sortColumn: "sort_order",
    pkColumn: "section_id",
    descending: false,
  },
};

export interface UseTasksResult {
  tasks: Task[];
  projects: Project[];
  sections: Section[];
  loading: boolean;
  connection: ReplicaQueryState["connection"];
  error?: string;
  unavailableReason?: string;
  /** The gateway is out of reach — the replica's own verdict, never invented. */
  offline: boolean;
  /** The moment this replica last matched the vault, when it knows one. */
  lastSyncedAt?: string;
  refresh: () => Promise<void>;
}

export function useTasks(): UseTasksResult {
  const tasks = useSeatPages(APP_ID, TASKS, {
    entity: "schedule.task",
    rowIdColumn: "task_id",
  });
  const projects = useSeatPages(APP_ID, PROJECTS, {
    entity: "schedule.project",
    rowIdColumn: "project_id",
  });
  const sections = useSeatPages(APP_ID, SECTIONS, {
    entity: "schedule.section",
    rowIdColumn: "section_id",
  });

  const queryState = combineReplicaQueryStates([tasks, projects, sections]);

  // Children nest under their parent on every seat — same nest as the pointer
  // `board` query, so completing a parent promotes unfinished children.
  const board = useMemo(() => {
    const rows = tasks.rows as unknown as Task[];
    const families = nestTaskFamilies(rows, (row, children) => ({
      ...row,
      children,
      done_children: children.filter(
        (child) => child.status === "completed" || child.status === "cancelled"
      ).length,
    }));
    return [...families.open, ...families.logbook];
  }, [tasks.rows]);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      tasks.refresh(),
      projects.refresh(),
      sections.refresh(),
    ]);
  };

  return {
    tasks: board,
    projects: projects.rows as unknown as Project[],
    sections: sections.rows as unknown as Section[],
    loading: queryState.loading,
    connection: queryState.connection,
    ...(queryState.error ? { error: queryState.error } : {}),
    ...(queryState.unavailableReason
      ? { unavailableReason: queryState.unavailableReason }
      : {}),
    ...(queryState.lastSyncedAt
      ? { lastSyncedAt: queryState.lastSyncedAt }
      : {}),
    offline: queryState.connection === "offline",
    refresh,
  };
}

/**
 * One write door for every Tasks act — `session.write` plus the kit's outcome
 * surfacing; returns the result on a continuable outcome, else `undefined`.
 */
export type TasksWrite = (
  action: string,
  input: Record<string, ReplicaValue>,
  scopeId?: string | null
) => Promise<NativeWriteResult | undefined>;

export function useTasksWrite(
  navigation: TasksScreenProps["navigation"]
): TasksWrite {
  const { session } = useReplica();
  return useCallback(
    // `_scopeId` is the project picker's vault, and it is no longer a write
    // TARGET (#996 wave 3): a seat opens one file. The signature keeps it
    // because the callers still choose a project, and dropping the argument
    // would move that choice's plumbing into this wave.
    async (action, input, _scopeId) => {
      if (!session) return undefined;
      try {
        const request = { action, input };
        // One open vault, so one write target (#996 wave 3).
        const result = await session.write(APP_ID, request);
        if (
          !surfaceWriteOutcome(result, {
            onParked: () =>
              navigation.navigate("Settings", { screen: "NeedsYou" }),
            queuedMessage: "This change will sync automatically.",
          })
        )
          return undefined;
        return result;
      } catch (error) {
        surfaceWriteFailure(error, "Task change not saved");
        return undefined;
      }
    },
    [navigation, session]
  );
}
