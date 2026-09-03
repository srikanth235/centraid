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
  offline: boolean;
  lastSyncedAt?: string;
  refresh: () => Promise<void>;
}

export function useTasks(): UseTasksResult {
  const tasks = useTasksEntity("schedule.task");
  const projects = useTasksEntity("schedule.project");
  const sections = useTasksEntity("schedule.section");

  const queryState = combineReplicaQueryStates([tasks, projects, sections]);

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
