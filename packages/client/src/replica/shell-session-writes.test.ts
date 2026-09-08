// THE SHELL'S WRITE RAIL, OVER A SEAT (#996, W5).
//
// What a member's write owes once the coordinator is gone: an idempotent post,
// a DURABLE queued answer while offline (the outbox is a table in the seat's
// file, so it exists before any copy does), revision of a write already queued
// over the same row instead of a second one layered on top, the gateway's own
// admission returned to the caller waiting for it, and a purge when the
// gateway says this browser is no longer enrolled.
import { beforeAll, describe, expect, test, vi } from "vitest";

import { stablePendingRowId } from "@centraid/blueprints/apps/_shared/pending-overlay";

import type { IntentRecordStore } from "./intent-record-store.js";
import { MemoryIntentStore } from "./memory-intent-store.js";
import type * as TypeImport_1vwuba6 from "./shell-session.js";
import {
  installGatewayApiStub,
  intent,
  options,
  outcomeResponse,
} from "./shell-session.test-fixtures.js";
import type { ReplicaFetcher } from "./shell-transport.js";

let ReplicaShellSession: typeof TypeImport_1vwuba6.ReplicaShellSession;

describe("the shell session's write rail", () => {
  beforeAll(async () => {
    installGatewayApiStub();
    ({ ReplicaShellSession } = await import("./shell-session.js"));
  });

  test("returns a durable queued acknowledgement immediately while offline", async () => {
    const store = new MemoryIntentStore();
    const session = new ReplicaShellSession(
      { baseUrl: "https://gateway.example", vaultId: "vault" },
      options({ intentStore: store })
    );
    await session.start();

    await expect(
      session.write("todos", {
        intentId: "intent-1",
        action: "complete",
        input: { taskId: "task-1" },
        optimistic: [
          {
            op: "upsert",
            entity: "core.task",
            rowId: "task-1",
            values: { cost: 42 },
          },
        ],
      })
    ).resolves.toStrictEqual({
      intentId: "intent-1",
      status: "queued",
      reason: "waiting for a connection",
    });
    const stored = await store.get("intent-1");
    // ONE DEPENDENCY, THE ENTITY. There is no catalog to expand it against.
    expect(stored?.dependencies).toStrictEqual([{ entity: "core.task" }]);
    expect(stored?.state).toBe("queued");
    await session.close();
  });

  test("queues a first-open offline write before any copy exists", async () => {
    const store = new MemoryIntentStore();
    const session = new ReplicaShellSession(
      { baseUrl: "https://gateway.example", vaultId: "vault" },
      options({ intentStore: store })
    );
    await session.start();

    await expect(
      session.write("todos", {
        intentId: "intent-1",
        action: "complete",
        input: { taskId: "task-1" },
        optimistic: [
          {
            op: "upsert",
            entity: "core.task",
            rowId: "task-1",
            values: { title: "Saved before the copy" },
          },
        ],
      })
    ).resolves.toMatchObject({ intentId: "intent-1", status: "queued" });
    // NO BASE VERSIONS: there is no file to read a canonical row from, and a
    // version invented here would be a precondition the gateway must fail.
    expect((await store.get("intent-1"))?.baseVersions).toBeUndefined();
    await session.close();
  });

  test("does not treat pending-shaped user copy as a synthetic row identity", async () => {
    const store = new MemoryIntentStore();
    const session = new ReplicaShellSession(
      { baseUrl: "https://gateway.example", vaultId: "vault" },
      options({ intentStore: store })
    );
    await session.start();

    const input = {
      task_id: "task-1",
      title: stablePendingRowId("ordinary", "content"),
    };
    await expect(
      session.write("todos", {
        intentId: "intent-1",
        action: "complete",
        input,
      })
    ).resolves.toMatchObject({ status: "queued" });
    expect((await store.get("intent-1"))?.input).toStrictEqual(input);
    await session.close();
  });

  test("enqueues a child write whose foreign key references a pending parent", async () => {
    const store = new MemoryIntentStore();
    const session = new ReplicaShellSession(
      { baseUrl: "https://gateway.example", vaultId: "vault" },
      options({ intentStore: store })
    );
    await session.start();

    // The parent is queued; the child NAMES its minted id. That is a new
    // intent, not a revision of the parent — the chain is the member's.
    await session.write("tasks", {
      intentId: "intent-project",
      action: "add-project",
      input: { name: "Trip" },
    });
    await expect(
      session.write("tasks", {
        intentId: "intent-child",
        action: "add",
        input: {
          project_id: stablePendingRowId("intent-project", "project"),
          title: "Child of a pending project",
        },
      })
    ).resolves.toMatchObject({
      intentId: "intent-child",
      status: "queued",
    });
    expect((await store.list()).map((item) => item.intentId)).toStrictEqual([
      "intent-project",
      "intent-child",
    ]);
    await session.close();
  });

  test("replaces a retained failed write instead of layering a second one", async () => {
    const store = new MemoryIntentStore();
    const session = new ReplicaShellSession(
      { baseUrl: "https://gateway.example", vaultId: "vault" },
      options({ intentStore: store })
    );
    await session.start();

    const optimistic = [
      {
        op: "upsert" as const,
        entity: "schedule.task",
        rowId: "task-1",
        values: { task_id: "task-1", title: "First title" },
      },
    ];
    await session.write("tasks", {
      intentId: "intent-task-original",
      action: "edit",
      input: { task_id: "task-1", title: "First title" },
      optimistic,
    });
    // The gateway refused it, and the row is still drawn with the member's
    // edit on it — that is a RETAINED write, and the fix for it is a
    // correction of the same intent.
    await store.transition("intent-task-original", ["queued"], {
      state: "failed",
      reason: "the gateway said no",
    });

    const revised = await session.write("tasks", {
      intentId: "intent-task-second",
      action: "edit",
      input: { task_id: "task-1", title: "Correct title" },
      optimistic: [
        {
          op: "upsert",
          entity: "schedule.task",
          rowId: "task-1",
          values: { task_id: "task-1", title: "Correct title" },
        },
      ],
    });
    expect(revised.status).toBe("queued");
    // TWO WRITES OVER ONE RETAINED ROW IS A CHAIN THE MEMBER DID NOT MAKE:
    // the correction supersedes the refusal rather than queueing behind it.
    const live = (await store.list()).filter((item) =>
      ["queued", "sending"].includes(item.state)
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.input).toStrictEqual({
      task_id: "task-1",
      title: "Correct title",
    });
    expect(live[0]?.intentId).not.toBe("intent-task-second");
    await session.close();
  });

  test("returns the gateway admission outcome for an online write", async () => {
    let online = false;
    const store = new MemoryIntentStore();
    const session = new ReplicaShellSession(
      { baseUrl: "https://gateway.example", vaultId: "vault" },
      options({
        intentStore: store,
        isOnline: () => online,
        fetcher: vi
          .fn<ReplicaFetcher>()
          .mockResolvedValue(
            outcomeResponse("intent-1", "parked", "confirm first")
          ),
      })
    );
    await session.start();
    online = true;

    await expect(
      session.write("todos", {
        intentId: "intent-1",
        action: "complete",
        input: { taskId: "task-1" },
      })
    ).resolves.toStrictEqual({
      intentId: "intent-1",
      status: "parked",
      reason: "confirm first",
    });
    expect((await store.get("intent-1"))?.state).toBe("parked");
    await session.close();
  });

  test("reruns an active drain when an enqueue races its empty claim", async () => {
    let releaseEmptyClaim: (() => void) | undefined;
    const emptyClaim = new Promise<undefined>((resolve) => {
      releaseEmptyClaim = () => resolve(undefined);
    });
    const store = new MemoryIntentStore();
    const real = store.claimNext.bind(store);
    const claimNext = vi
      .fn<IntentRecordStore["claimNext"]>(() => real())
      .mockReturnValueOnce(emptyClaim);
    const session = new ReplicaShellSession(
      { baseUrl: "https://gateway.example", vaultId: "vault" },
      options({
        intentStore: Object.assign(store, { claimNext }),
        isOnline: () => true,
        fetcher: vi
          .fn<ReplicaFetcher>()
          .mockResolvedValue(
            outcomeResponse("intent-1", "parked", "confirm first")
          ),
      })
    );
    await session.start();
    await vi.waitFor(() => expect(claimNext).toHaveBeenCalledOnce());

    // The claim in flight found nothing; this write lands BEHIND it, and a
    // drain that did not rerun would leave it queued with nobody coming back
    // for it until the next event.
    const result = session.write("todos", {
      intentId: "intent-1",
      action: "complete",
      input: { taskId: "task-1" },
    });
    await vi.waitFor(
      async () => await expect(store.get("intent-1")).resolves.toBeDefined()
    );
    releaseEmptyClaim?.();

    await expect(result).resolves.toStrictEqual({
      intentId: "intent-1",
      status: "parked",
      reason: "confirm first",
    });
    await session.close();
  });

  test("purges this scope's storage when the gateway revokes authorization", async () => {
    const store = new MemoryIntentStore();
    await store.add({ ...intent(), state: "queued" });
    const revoked =
      vi.fn<
        NonNullable<
          TypeImport_1vwuba6.ReplicaShellSessionOptions<TypeImport_1vwuba6.ReplicaShellSession>["onAuthorizationRevoked"]
        >
      >();
    const session = new ReplicaShellSession(
      { baseUrl: "https://gateway.example", vaultId: "vault" },
      options({
        intentStore: store,
        isOnline: () => true,
        onAuthorizationRevoked: revoked,
        fetcher: vi
          .fn<ReplicaFetcher>()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ error: "replica_device_not_enrolled" }),
              { status: 403 }
            )
          ),
      })
    );
    await session.start();
    await session.flushIntents();

    expect(revoked).toHaveBeenCalledWith(session);
  });
});
