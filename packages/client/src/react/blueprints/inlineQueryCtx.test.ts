import { describe, expect, it } from "vitest";

import {
  PENDING_OVERLAY_FIELDS,
  pendingSidecarOf,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import boardQuery from "@centraid/blueprints/apps/tasks/queries/board";
import { seededRandom } from "@centraid/test-kit/random";

import { OnlineOnlyGuard } from "../../replica/errors.js";
import type { ShellReplicaReadRequest } from "../../replica/shell-session.js";
import type {
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
} from "../../replica/types.js";
import { buildInlineCtx, runInlineQuery } from "./inlineQueryCtx.js";
import type { InlineReplicaSession } from "./inlineQueryCtx.js";

const cursor = { epoch: "e1", seq: 7 };
const dependency = { shapeId: "tasks/board", entity: "schedule.task" };

// Only a stand-in row id for fixtures that omit `task_id`; seeded so the same
// fixture gets the same synthetic id on every run.
const rowIds = seededRandom(20_260_731);

function envelope(
  values: Record<string, unknown>,
  extra?: Partial<ReplicaRowEnvelope>
): ReplicaRowEnvelope {
  return {
    rowId: String(values.task_id ?? rowIds.next()),
    values: values as ReplicaRowEnvelope["values"],
    oversizedFields: [],
    hasUnavailableFields: false,
    ...extra,
  };
}

const OPEN_TASKS = [
  {
    task_id: "b",
    status: "needs-action",
    title: "Second",
    due_at: null,
    priority: 0,
  },
  {
    task_id: "a",
    status: "needs-action",
    title: "First",
    due_at: "2026-07-22",
    priority: 1,
  },
];

/** A replica-session double: seeded open tasks; everything else empty. */
function seededSession(
  overrides?: Partial<InlineReplicaSession>
): InlineReplicaSession {
  return {
    async read(
      _appId: string,
      request: ShellReplicaReadRequest
    ): Promise<ReplicaReadWireResult> {
      const statusClause = (request.where ?? []).find(
        (clause) => clause.column === "status"
      );
      const statusValue = statusClause?.value;
      const wantsOpen =
        request.entity === "schedule.task" &&
        Array.isArray(statusValue) &&
        (statusValue as string[]).includes("needs-action");
      return {
        rows: wantsOpen ? OPEN_TASKS.map((task) => envelope(task)) : [],
        cursor,
        dependency,
      };
    },
    async search(): Promise<ReplicaSearchWireResult> {
      return { rows: [], cursor, dependency };
    },
    ...overrides,
  };
}

describe("inlineQueryCtx", () => {
  it("runs the real board query against the local replica and projects tasks", async () => {
    const result = (await runInlineQuery(
      { default: boardQuery },
      {
        session: seededSession(),
        appId: "tasks",
        input: { limit: 500 },
        isOnline: () => false,
      }
    )) as {
      open: Array<{ task_id: string; title: string }>;
      vaultDenied?: unknown;
    };

    expect(result.vaultDenied).toBeUndefined();
    expect(result.open).toHaveLength(2);
    // due-first sort: the dated task leads the undated one.
    expect(result.open.map((t) => t.title)).toStrictEqual(["First", "Second"]);
  });

  it("resolves mentions to {cards:[]} offline and never rejects", async () => {
    const guard = new OnlineOnlyGuard();
    const ctx = buildInlineCtx(
      { session: seededSession(), appId: "tasks", isOnline: () => false },
      guard
    ) as { vault: { resolve: () => Promise<{ cards: unknown[] }> } };
    await expect(ctx.vault.resolve()).resolves.toStrictEqual({ cards: [] });
    expect(guard.required).toBe(false);
  });

  it("settles an OPTIONAL invocation as failed and leaves the run local", async () => {
    const guard = new OnlineOnlyGuard();
    const ctx = buildInlineCtx(
      { session: seededSession(), appId: "locker" },
      guard
    ) as {
      vault: {
        invoke: (request: {
          command: string;
          purpose: string;
          optional?: boolean;
        }) => Promise<{ status: string }>;
      };
    };
    // A DECORATION the answer stands without: the handler's own
    // `status !== "executed"` branch is the offline branch (#928).
    await expect(
      ctx.vault.invoke({
        command: "locker.watchtower",
        purpose: "dpv:ServiceProvision",
        optional: true,
      })
    ).resolves.toMatchObject({ status: "failed" });
    expect(guard.required).toBe(false);
    // An invocation that did NOT declare itself optional is an effect this
    // seat cannot perform, and it still marks the run.
    await expect(
      ctx.vault.invoke({
        command: "locker.watchtower",
        purpose: "dpv:ServiceProvision",
      })
    ).rejects.toThrow(/online-only/u);
    expect(guard.required).toBe(true);
  });

  it("marks the online-only guard when a query reads an undisclosed field", async () => {
    const undisclosed = seededSession({
      async read(): Promise<ReplicaReadWireResult> {
        return {
          rows: [
            envelope(
              { task_id: "x", status: "needs-action" },
              { hasUnavailableFields: true }
            ),
          ],
          cursor,
          dependency,
        };
      },
    });
    // board reads `.title`/`.due_at` which are undisclosed here → guard fires →
    // runInlineQuery rejects with the fallback code.
    await expect(
      runInlineQuery(
        { default: boardQuery },
        { session: undisclosed, appId: "tasks", input: {} }
      )
    ).rejects.toMatchObject({ code: "ONLINE_ONLY" });
  });

  it("carries shell-owned pending metadata through an app's decorated row", async () => {
    const pendingSession = seededSession({
      async read(): Promise<ReplicaReadWireResult> {
        return {
          rows: [
            {
              rowId: "party-pending",
              values: {
                party_id: "party-pending",
                display_name: "Asha",
                [PENDING_OVERLAY_FIELDS.key]: "intent-person",
              },
              oversizedFields: [],
              hasUnavailableFields: false,
            },
          ],
          cursor,
          dependency,
          pending: {
            "intent-person": {
              status: "conflict",
              action: "edit-person",
              reason: "The person changed.",
            },
          },
        };
      },
    });
    const result = (await runInlineQuery(
      {
        default: async ({ ctx }: { ctx: unknown }) => {
          const local = ctx as {
            vault: {
              read: (request: {
                entity: string;
                acceptTruncation?: boolean;
              }) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
          const read = await local.vault.read({
            entity: "schedule.task",
            acceptTruncation: true,
          });
          return {
            people: read.rows.map((row) => ({
              party_id: row.party_id,
              name: row.display_name,
            })),
          };
        },
      } as never,
      {
        session: pendingSession,
        appId: "people",
        scopeId: "family-vault",
      }
    )) as { people: Record<string, unknown>[] };

    const person = result.people[0]!;
    expect(person).toMatchObject({
      party_id: "party-pending",
      name: "Asha",
      [PENDING_OVERLAY_FIELDS.key]: "intent-person",
      __centraidScopeId: "family-vault",
    });
    // The facts ride the read's sidecar, carried with the row (#922 G3).
    expect(readPendingOverlay(person, pendingSidecarOf(person))).toMatchObject({
      key: "intent-person",
      status: "conflict",
      reason: "The person changed.",
    });
    expect(
      Object.keys(person).filter((column) =>
        column.startsWith("__centraid_pending")
      )
    ).toStrictEqual([PENDING_OVERLAY_FIELDS.key]);
  });

  it("does not let a pending foreign key overwrite a child row's controls", async () => {
    // #922 G2: minted ids are canonical; the pending fact is the overlay's.
    const taskId = "1f2e3d4c-0000-8000-8000-00000000000a";
    const projectId = "1f2e3d4c-0000-8000-8000-00000000000b";
    const pendingSession = seededSession({
      async read(
        _appId: string,
        request: ShellReplicaReadRequest
      ): Promise<ReplicaReadWireResult> {
        const row: ReplicaRowEnvelope =
          request.entity === "schedule.project"
            ? {
                rowId: projectId,
                values: {
                  project_id: projectId,
                  name: "Pending project",
                  [PENDING_OVERLAY_FIELDS.key]: "intent-project",
                },
                oversizedFields: [],
                hasUnavailableFields: false,
              }
            : {
                rowId: taskId,
                values: {
                  task_id: taskId,
                  project_id: projectId,
                  title: "Child task",
                  [PENDING_OVERLAY_FIELDS.key]: "intent-task",
                },
                oversizedFields: [],
                hasUnavailableFields: false,
              };
        return {
          rows: [row],
          cursor,
          dependency,
          pending: {
            "intent-project": { status: "queued", action: "save-project" },
            "intent-task": { status: "failed", action: "add" },
          },
        };
      },
    });

    const result = (await runInlineQuery(
      {
        default: async ({ ctx }: { ctx: unknown }) => {
          const local = ctx as {
            vault: {
              read: (
                request: ShellReplicaReadRequest
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
          const [tasks, projects] = await Promise.all([
            local.vault.read({
              entity: "schedule.task",
              acceptTruncation: true,
            }),
            local.vault.read({
              entity: "schedule.project",
              acceptTruncation: true,
            }),
          ]);
          const task = tasks.rows[0]!;
          return {
            task: {
              task_id: task.task_id,
              project_id: task.project_id,
              title: task.title,
            },
            project: { ...projects.rows[0] },
          };
        },
      } as never,
      { session: pendingSession, appId: "tasks" }
    )) as {
      task: Record<string, unknown>;
      project: Record<string, unknown>;
    };

    expect(result.task).toMatchObject({
      task_id: taskId,
      project_id: projectId,
      [PENDING_OVERLAY_FIELDS.key]: "intent-task",
    });
    expect(
      readPendingOverlay(result.task, pendingSidecarOf(result.task))?.action
    ).toBe("add");
    expect(result.task[PENDING_OVERLAY_FIELDS.key]).not.toBe("intent-project");
    expect(result.project).toMatchObject({
      project_id: projectId,
      [PENDING_OVERLAY_FIELDS.key]: "intent-project",
    });
    expect(
      readPendingOverlay(result.project, pendingSidecarOf(result.project))
        ?.action
    ).toBe("save-project");
  });
});
