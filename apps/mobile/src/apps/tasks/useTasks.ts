// The Tasks read layer (issue #834) — the board, projected from this device's
// consent-shaped replica, exactly the entity set the `tasks` manifest's read
// scopes grant (packages/blueprints/apps/tasks/app.json).
//
// Same shape as `useDocs`: one `useReplicaQuery` per entity, one combined
// honesty state, one memoized projection. The BOARD's own arithmetic is not
// restated here — the grouping, the overdue rule and the undated-never-Today
// rule are imported from `@centraid/blueprints/apps/tasks/logic`, so the phone
// and the pointer seats cannot answer "what is due today" two different ways.
//
// WHAT THE PHONE CANNOT DO HERE, AND SAYS SO. The replica projects rows, not
// the `board` query's server-side recurrence collapse; a repeating row on this
// seat therefore renders the fields it carries and no invented count. The
// summariser is never re-implemented — one engine, or none.

import { useCallback, useMemo } from "react";

import { nestTaskFamilies } from "@centraid/blueprints/apps/tasks/logic";
import type {
  Project,
  Section,
  Task,
} from "@centraid/blueprints/apps/tasks/types";
import type { ReplicaValue } from "@centraid/client/replica/native";

import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import type { ReplicaQueryState } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { TasksScreenProps } from "../../navigation";

const APP_ID = "tasks";

function useTasksEntity(entity: string): ReplicaQueryState {
  return useReplicaQuery(
    APP_ID,
    useMemo(() => ({ entity }), [entity])
  );
}

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
  const tasks = useTasksEntity("schedule.task");
  const projects = useTasksEntity("schedule.project");
  const sections = useTasksEntity("schedule.section");

  const queryState = combineReplicaQueryStates([tasks, projects, sections]);

  // A family travels with its parent on every seat, so the children are nested
  // here rather than left as loose rows the list would draw twice. Completing
  // a parent promotes its unfinished children onto the open board — the same
  // nest the pointer seat's `board` query uses.
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

  // A plain function — react-compiler memoizes the hook result; a manual
  // dependency list over three query objects would only get stale.
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
 * surfacing (executed / parked→Approvals / queued / refused). Returns the
 * result on a continuable outcome and `undefined` otherwise, so a caller can
 * chain an optimistic follow-up without inspecting the status itself.
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
    async (action, input, scopeId) => {
      if (!session) return undefined;
      try {
        const request = { action, input };
        const result =
          scopeId && session.writeTo
            ? await session.writeTo(scopeId, APP_ID, request)
            : await session.write(APP_ID, request);
        if (
          !surfaceWriteOutcome(result, {
            onParked: () =>
              navigation.navigate("Settings", { screen: "Approvals" }),
            queuedMessage: "This change will sync automatically.",
          })
        )
          return undefined;
        return result;
      } catch (error) {
        surfaceWriteFailure(error, "Task change failed");
        return undefined;
      }
    },
    [navigation, session]
  );
}
