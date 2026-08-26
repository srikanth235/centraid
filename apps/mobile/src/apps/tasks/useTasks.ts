// Tasks read layer (#834): board projected from this device's consent-shaped
// replica; board arithmetic is imported from the blueprint logic, never
// restated here. Rows carry their fields, never an invented recurrence count.

import { useCallback, useMemo } from "react";

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

  // Children travel nested under their parent on every seat.
  const board = useMemo(() => {
    const rows = tasks.rows as unknown as Task[];
    const childrenOf = new Map<string, Task[]>();
    for (const row of rows) {
      if (!row.parent_task_id) continue;
      if (!childrenOf.has(row.parent_task_id))
        childrenOf.set(row.parent_task_id, []);
      childrenOf.get(row.parent_task_id)?.push(row);
    }
    return rows
      .filter((row) => !row.parent_task_id)
      .map((row) => {
        const children = childrenOf.get(row.task_id) ?? [];
        return {
          ...row,
          children,
          done_children: children.filter(
            (child) =>
              child.status === "completed" || child.status === "cancelled"
          ).length,
        };
      });
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
  input: Record<string, ReplicaValue>
) => Promise<NativeWriteResult | undefined>;

export function useTasksWrite(
  navigation: TasksScreenProps["navigation"]
): TasksWrite {
  const { session } = useReplica();
  return useCallback(
    async (action, input) => {
      if (!session) return undefined;
      try {
        const result = await session.write(APP_ID, { action, input });
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
