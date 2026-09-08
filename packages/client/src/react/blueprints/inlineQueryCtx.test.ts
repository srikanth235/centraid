import { describe, expect, it } from "vitest";

import {
  attachPendingSidecar,
  PENDING_OVERLAY_FIELDS,
  pendingSidecarOf,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingOverlaySidecar } from "@centraid/blueprints/apps/_shared/pending-overlay";
import boardQuery from "@centraid/blueprints/apps/tasks/queries/board";
import searchQuery from "@centraid/blueprints/apps/tasks/queries/search";
import { seededRandom } from "@centraid/test-kit/random";

import { OnlineOnlyGuard } from "../../replica/errors.js";
import type {
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

/**
 * A replica-session double: seeded open tasks; everything else empty.
 *
 * It answers PAGES now (#996 wave 4). The board's reads are statements-as-data
 * through `ctx.vault.page`, keyed by the handler name the statement carries, so
 * a double that only knew `read` would leave the board on the online-only stub
 * — which is the one thing this test exists to prove does not happen.
 */
function seededSession(
  overrides?: Partial<InlineReplicaSession>
): InlineReplicaSession {
  return {
    page: (async (query: { name: string }) => ({
      rows: query.name === "tasks.board.open" ? OPEN_TASKS : [],
    })) as unknown as NonNullable<InlineReplicaSession["page"]>,
    async search(): Promise<ReplicaSearchWireResult> {
      return { rows: [], cursor, dependency };
    },
    ...overrides,
  };
}

/** A page door whose rows are whatever the test says, with their sidecar. */
function pageDoor(
  rowsFor: (name: string) => Array<Record<string, unknown>>,
  sidecar: PendingOverlaySidecar
): NonNullable<InlineReplicaSession["page"]> {
  return (async (query: { name: string }) => ({
    rows: rowsFor(query.name).map((row) => attachPendingSidecar(row, sidecar)),
  })) as unknown as NonNullable<InlineReplicaSession["page"]>;
}

/** The one field of a `PageQuery` these tests need: the handler's key. */
function pageQuery(name: string, pkColumn: string): unknown {
  return {
    name,
    select: "*",
    from: name,
    order: { sortColumn: pkColumn, pkColumn, direction: "asc" },
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
          optional?: boolean;
        }) => Promise<{ status: string }>;
      };
    };
    // A DECORATION the answer stands without: the handler's own
    // `status !== "executed"` branch is the offline branch (#928).
    await expect(
      ctx.vault.invoke({
        command: "locker.watchtower",
        optional: true,
      })
    ).resolves.toMatchObject({ status: "failed" });
    expect(guard.required).toBe(false);
    // An invocation that did NOT declare itself optional is an effect this
    // seat cannot perform, and it still marks the run.
    await expect(
      ctx.vault.invoke({
        command: "locker.watchtower",
      })
    ).rejects.toThrow(/online-only/u);
    expect(guard.required).toBe(true);
  });

  it("marks the online-only guard when a query reads an undisclosed field", async () => {
    // THE BOARD NO LONGER PROVES THIS, AND THAT IS THE POINT (#996 wave 4, R8).
    // Its rows come off the seat's own file with every column present, so
    // there is nothing on that path for the mask to withhold. The guard is
    // still exactly as live for a handler that READS, and Tasks' search is one:
    // the ranked hits arrive as envelopes, and the handler touches `.title`.
    const undisclosed = seededSession({
      async search(): Promise<ReplicaSearchWireResult> {
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
    await expect(
      runInlineQuery(
        { default: searchQuery },
        { session: undisclosed, appId: "tasks", input: { term: "ferry" } }
      )
    ).rejects.toMatchObject({ code: "ONLINE_ONLY" });
  });

  it("carries shell-owned pending metadata through an app's decorated row", async () => {
    // #922 G3, on the page door (#996 W5): the seat's worker drew the outbox
    // over these rows, so the key is ON the row and the facts ride the
    // sidecar the page carried — the app copies neither by hand.
    const pendingSession = seededSession({
      page: pageDoor(
        () => [
          {
            party_id: "party-pending",
            display_name: "Asha",
            [PENDING_OVERLAY_FIELDS.key]: "intent-person",
          },
        ],
        {
          "intent-person": {
            status: "conflict",
            action: "edit-person",
            reason: "The person changed.",
          },
        }
      ),
    });
    const result = (await runInlineQuery(
      {
        default: async ({ ctx }: { ctx: unknown }) => {
          const local = ctx as {
            vault: {
              page: (request: {
                query: unknown;
                limit: number;
              }) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
          const page = await local.vault.page({
            query: pageQuery("people.roster", "party_id"),
            limit: 50,
          });
          return {
            people: page.rows.map((row) => ({
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
    // The facts ride the page's sidecar, carried with the row (#922 G3).
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
      page: pageDoor(
        (name) =>
          name === "tasks.projects"
            ? [
                {
                  project_id: projectId,
                  name: "Pending project",
                  [PENDING_OVERLAY_FIELDS.key]: "intent-project",
                },
              ]
            : [
                {
                  task_id: taskId,
                  project_id: projectId,
                  title: "Child task",
                  [PENDING_OVERLAY_FIELDS.key]: "intent-task",
                },
              ],
        {
          "intent-project": { status: "queued", action: "save-project" },
          "intent-task": { status: "failed", action: "add" },
        }
      ),
    });

    const result = (await runInlineQuery(
      {
        default: async ({ ctx }: { ctx: unknown }) => {
          const local = ctx as {
            vault: {
              page: (request: {
                query: unknown;
                limit: number;
              }) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
          const [tasks, projects] = await Promise.all([
            local.vault.page({
              query: pageQuery("tasks.board", "task_id"),
              limit: 50,
            }),
            local.vault.page({
              query: pageQuery("tasks.projects", "project_id"),
              limit: 50,
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
