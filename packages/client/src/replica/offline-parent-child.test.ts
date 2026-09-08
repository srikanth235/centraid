/*
 * An offline child write that references an offline-created parent (#922 G2).
 *
 * A member creates a project on a plane and immediately files a task in it.
 * Both writes queue. On reconnect the project must land AS THE ROW THE TASK
 * ALREADY NAMES — which is only possible if the row's id was minted at the
 * seat, carried in the write, and honoured by the origin. When the origin
 * mints its own id instead, the task lands pointing at a project that never
 * existed, and the member's plane work is quietly wrong.
 */
import { describe, expect, test } from "vitest";

import { projectPendingWrite } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { pendingProjectionFor } from "@centraid/blueprints/apps/_shared/pending-projections";

import { IntentQueue } from "./intents.js";
import { MemoryIntentStore } from "./memory-intent-store.js";
import type {
  IntentOutcome,
  OptimisticMutation,
  ReplicaValue,
} from "./types.js";

/** The write door both seats implement: project, then send input ⊕ minted ids. */
function writeDoor(
  appId: string,
  action: string,
  input: Record<string, unknown>,
  intentId: string
): {
  intentId: string;
  input: Record<string, unknown>;
  optimistic: OptimisticMutation[];
} {
  const projected = projectPendingWrite(pendingProjectionFor(appId), {
    appId,
    action,
    input,
    intentId,
  });
  return {
    intentId,
    input: { ...input, ...projected.input },
    optimistic: projected.optimistic as OptimisticMutation[],
  };
}

/**
 * An origin that HONOURS a row id the write carries and refuses a duplicate.
 * Anything it is not given, it mints — which is what makes the offline child
 * case fail when the seat does not mint.
 */
function origin() {
  const projects = new Set<string>();
  const tasks = new Map<string, { task_id: string; project_id?: string }>();
  let minted = 0;
  return {
    projects,
    tasks,
    execute(
      action: string,
      input: Record<string, unknown>
    ): IntentOutcome & {
      output: Record<string, unknown>;
    } {
      if (action === "save-project") {
        const supplied = input.project_id;
        const projectId =
          typeof supplied === "string"
            ? supplied
            : `origin-project-${(minted += 1)}`;
        if (projects.has(projectId)) {
          return {
            intentId: "",
            status: "denied",
            reason: "that project already exists",
            output: {},
          };
        }
        projects.add(projectId);
        return {
          intentId: "",
          status: "executed",
          output: { project_id: projectId },
        };
      }
      const supplied = input.task_id;
      const taskId =
        typeof supplied === "string"
          ? supplied
          : `origin-task-${(minted += 1)}`;
      const projectId = input.project_id;
      tasks.set(taskId, {
        task_id: taskId,
        ...(typeof projectId === "string" ? { project_id: projectId } : {}),
      });
      return { intentId: "", status: "executed", output: { task_id: taskId } };
    },
  };
}

describe("an offline child write on an offline-created parent", () => {
  test("lands on reconnect naming the row the seat already showed", async () => {
    const queue = new IntentQueue(new MemoryIntentStore(), {
      idFactory: () => `intent-${queueIds++}`,
    });
    const gateway = origin();

    // On the plane: a project, then a task filed in it.
    const project = writeDoor(
      "tasks",
      "save-project",
      { name: "Kitchen" },
      "intent-project"
    );
    await queue.enqueue({
      appId: "tasks",
      action: "save-project",
      input: project.input as ReplicaValue,
      intentId: project.intentId,
      optimistic: project.optimistic,
    });
    const projectRow = project.optimistic.find(
      (mutation) => mutation.entity === "schedule.project"
    );
    expect(projectRow).toBeDefined();
    const projectId = projectRow?.rowId ?? "";
    // THE SEAT MINTED IT AND THE WRITE CARRIES IT.
    expect(project.input.project_id).toBe(projectId);

    const task = writeDoor(
      "tasks",
      "add",
      { title: "Grout", project_id: projectId },
      "intent-task"
    );
    await queue.enqueue({
      appId: "tasks",
      action: "add",
      input: task.input as ReplicaValue,
      intentId: task.intentId,
      optimistic: task.optimistic,
    });

    // Reconnect: the queue drains in order.
    const drained = [
      ["intent-project", "save-project", project.input],
      ["intent-task", "add", task.input],
    ] as const;
    // Sequential on purpose: the outbox drains in order, and the child's
    // parent must exist by the time the child is executed.
    for (const [intentId, action, input] of drained) {
      const outcome = gateway.execute(action, input);
      expect(outcome.status).toBe("executed");
      // oxlint-disable-next-line no-await-in-loop -- (#922) ordered drain
      await queue.claimNext();
      // oxlint-disable-next-line no-await-in-loop -- (#922) ordered drain
      await queue.applyOutcomes([{ ...outcome, intentId }]);
    }

    // The project the origin holds is the one the seat showed, and the task
    // points at it — not at a row the origin invented.
    expect([...gateway.projects]).toStrictEqual([projectId]);
    expect([...gateway.tasks.values()][0]?.project_id).toBe(projectId);
    // Nothing is left wearing a badge.
    expect((await queue.overlay()).mutations).toStrictEqual([]);
  });

  test("the origin refuses a row id it already holds rather than merging into it", () => {
    const gateway = origin();
    const first = writeDoor(
      "tasks",
      "save-project",
      { name: "Kitchen" },
      "intent-a"
    );
    expect(gateway.execute("save-project", first.input).status).toBe(
      "executed"
    );
    expect(gateway.execute("save-project", first.input).status).toBe("denied");
  });
});

let queueIds = 1;
