import { beforeAll, describe, expect, test, vi } from "vitest";

import type { ShellReplicaCoordinator } from "./shell-session.js";
import type * as TypeImport_1vwuba6 from "./shell-session.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import type { ReplicaIntent, ReplicaShape } from "./types.js";

let ReplicaShellSession: typeof TypeImport_1vwuba6.ReplicaShellSession;

describe("shell-session-admission", () => {
  beforeAll(async () => {
    Object.assign(window, {
      CentraidApi: {
        onGatewayChanged: () => () => undefined,
        onVaultChanged: () => () => undefined,
      },
    });
    ({ ReplicaShellSession } = await import("./shell-session.js"));
  });

  const shape: ReplicaShape = {
    shapeId: "shape-todos",
    appId: "todos",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "core.task",
        primaryKey: "task_id",
        columns: ["task_id", "title"],
      },
    ],
  };

  function queuedIntent(intentId: string): ReplicaIntent {
    return {
      intentId,
      payloadHash: "a".repeat(64),
      appId: "todos",
      action: "complete",
      input: { taskId: "task-1" },
      state: "queued",
      createdOrder: 1,
      attempts: 0,
      optimistic: [],
    };
  }

  function coordinator(
    overrides: Partial<ShellReplicaCoordinator> = {}
  ): ShellReplicaCoordinator {
    return {
      bootstrap: vi
        .fn<ShellReplicaCoordinator["bootstrap"]>()
        .mockResolvedValue({ epoch: "e", seq: 1 }),
      status: vi
        .fn<ShellReplicaCoordinator["status"]>()
        .mockResolvedValue({ mode: "memory", cursor: null, schemaEpoch: null }),
      catalog: vi
        .fn<ShellReplicaCoordinator["catalog"]>()
        .mockResolvedValue([shape]),
      readWire: vi.fn<ShellReplicaCoordinator["readWire"]>(),
      searchWire: vi.fn<ShellReplicaCoordinator["searchWire"]>(),
      enqueue: vi.fn<ShellReplicaCoordinator["enqueue"]>(),
      claimNextIntent: vi
        .fn<ShellReplicaCoordinator["claimNextIntent"]>()
        .mockResolvedValue(undefined),
      markIntentTransportFailed: vi.fn<
        ShellReplicaCoordinator["markIntentTransportFailed"]
      >(async (intentId, reason) => ({
        ...queuedIntent(intentId),
        reason,
      })),
      markIntentAwaitingChange: vi.fn<
        ShellReplicaCoordinator["markIntentAwaitingChange"]
      >(
        async (intentId: string): Promise<ReplicaIntent> => ({
          ...queuedIntent(intentId),
          state: "awaiting-change",
        })
      ),
      applyIntentOutcome: vi
        .fn<ShellReplicaCoordinator["applyIntentOutcome"]>()
        .mockResolvedValue(undefined),
      recoverSending: vi
        .fn<ShellReplicaCoordinator["recoverSending"]>()
        .mockResolvedValue([]),
      pendingIntents: vi
        .fn<ShellReplicaCoordinator["pendingIntents"]>()
        .mockResolvedValue([]),
      subscribeInvalidations: vi
        .fn<ShellReplicaCoordinator["subscribeInvalidations"]>()
        .mockReturnValue(() => undefined),
      close: vi
        .fn<ShellReplicaCoordinator["close"]>()
        .mockResolvedValue(undefined),
      purge: vi
        .fn<ShellReplicaCoordinator["purge"]>()
        .mockResolvedValue(undefined),
      ...overrides,
    };
  }

  describe("ReplicaShellSession admission ordering", () => {
    test("connectivity loss after waiter registration resolves the write as durably queued", async () => {
      let phase: "start" | "write" = "start";
      let onlineChecks = 0;
      const queued = queuedIntent("offline-race");
      const replica = coordinator({
        enqueue: vi
          .fn<ShellReplicaCoordinator["enqueue"]>()
          .mockResolvedValue(queued),
      });
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        replica,
        {
          eventTarget: new EventTarget(),
          isOnline: () => phase === "write" && ++onlineChecks === 1,
        }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      phase = "write";

      await expect(
        session.write("todos", { action: queued.action, input: queued.input })
      ).resolves.toStrictEqual({
        intentId: queued.intentId,
        status: "queued",
        reason: "saved locally; waiting for a connection",
      });
      await session.close();
    });

    test("an IndexedDB claim failure rejects every registered admission waiter", async () => {
      let online = false;
      const queued = queuedIntent("claim-failed");
      const replica = coordinator({
        enqueue: vi
          .fn<ShellReplicaCoordinator["enqueue"]>()
          .mockResolvedValue(queued),
        claimNextIntent: vi
          .fn<ShellReplicaCoordinator["claimNextIntent"]>()
          .mockRejectedValue(new Error("IndexedDB unavailable")),
      });
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        replica,
        { eventTarget: new EventTarget(), isOnline: () => online }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      online = true;

      await expect(
        session.write("todos", { action: queued.action, input: queued.input })
      ).rejects.toThrow("IndexedDB unavailable");
      await session.close();
    });

    test("fans one same-id admission result out to every concurrent writer", async () => {
      let online = false;
      const queued = queuedIntent("shared-intent");
      const replica = coordinator({
        enqueue: vi
          .fn<ShellReplicaCoordinator["enqueue"]>()
          .mockResolvedValue(queued),
        claimNextIntent: vi
          .fn<() => Promise<ReplicaIntent | undefined>>()
          .mockResolvedValueOnce(queued)
          .mockResolvedValue(undefined),
      });
      const fetcher = vi
        .fn<ReplicaFetcher>()
        .mockResolvedValue(
          responseFor(queued.intentId, "parked", "confirm first")
        );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        replica,
        { fetcher, eventTarget: new EventTarget(), isOnline: () => online }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      online = true;

      const results = await Promise.all([
        session.write("todos", {
          intentId: queued.intentId,
          action: queued.action,
          input: queued.input,
        }),
        session.write("todos", {
          intentId: queued.intentId,
          action: queued.action,
          input: queued.input,
        }),
      ]);

      expect(results).toStrictEqual([
        {
          intentId: queued.intentId,
          status: "parked",
          reason: "confirm first",
        },
        {
          intentId: queued.intentId,
          status: "parked",
          reason: "confirm first",
        },
      ]);
      expect(fetcher).toHaveBeenCalledOnce();
      await session.close();
    });

    test("includes a same-id writer that registers while the first post is settling", async () => {
      let online = false;
      const queued = queuedIntent("shared-intent");
      const duplicateEnqueue = deferred<ReplicaIntent>();
      const post = deferred<Response>();
      const replica = coordinator({
        enqueue: vi
          .fn<ShellReplicaCoordinator["enqueue"]>()
          .mockResolvedValueOnce(queued)
          .mockReturnValueOnce(duplicateEnqueue.promise),
        claimNextIntent: vi
          .fn<() => Promise<ReplicaIntent | undefined>>()
          .mockResolvedValueOnce(queued)
          .mockResolvedValue(undefined),
      });
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        replica,
        {
          fetcher: vi.fn<ReplicaFetcher>().mockReturnValue(post.promise),
          eventTarget: new EventTarget(),
          isOnline: () => online,
        }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      online = true;

      const first = session.write("todos", {
        intentId: queued.intentId,
        action: queued.action,
        input: queued.input,
      });
      await vi.waitFor(() =>
        expect(replica.claimNextIntent).toHaveBeenCalledOnce()
      );
      const duplicate = session.write("todos", {
        intentId: queued.intentId,
        action: queued.action,
        input: queued.input,
      });
      await vi.waitFor(() => expect(replica.enqueue).toHaveBeenCalledTimes(2));

      post.resolve(responseFor(queued.intentId, "parked", "confirm first"));
      duplicateEnqueue.resolve({ ...queued, state: "sending" });

      await expect(Promise.all([first, duplicate])).resolves.toStrictEqual([
        {
          intentId: queued.intentId,
          status: "parked",
          reason: "confirm first",
        },
        {
          intentId: queued.intentId,
          status: "parked",
          reason: "confirm first",
        },
      ]);
      await session.close();
    });

    test("does not claim a newly durable intent before its admission waiter is installed", async () => {
      const previous = queuedIntent("previous-intent");
      const queued = queuedIntent("new-intent");
      const enqueueGate = deferred<ReplicaIntent>();
      const previousPost = deferred<Response>();
      const claimNextIntent = vi
        .fn<() => Promise<ReplicaIntent | undefined>>()
        .mockResolvedValueOnce(previous)
        .mockResolvedValueOnce(queued)
        .mockResolvedValue(undefined);
      const replica = coordinator({
        enqueue: vi
          .fn<ShellReplicaCoordinator["enqueue"]>()
          .mockReturnValue(enqueueGate.promise),
        claimNextIntent,
      });
      const fetcher = vi
        .fn<ReplicaFetcher>()
        .mockReturnValueOnce(previousPost.promise)
        .mockResolvedValueOnce(
          responseFor(queued.intentId, "parked", "confirm new")
        );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        replica,
        { fetcher, eventTarget: new EventTarget(), isOnline: () => true }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

      const result = session.write("todos", {
        intentId: queued.intentId,
        action: queued.action,
        input: queued.input,
      });
      await vi.waitFor(() => expect(replica.enqueue).toHaveBeenCalledOnce());
      previousPost.resolve(
        responseFor(previous.intentId, "parked", "confirm previous")
      );
      await vi.waitFor(() =>
        expect(replica.applyIntentOutcome).toHaveBeenCalledOnce()
      );
      expect(claimNextIntent).toHaveBeenCalledOnce();

      enqueueGate.resolve(queued);
      await expect(result).resolves.toStrictEqual({
        intentId: queued.intentId,
        status: "parked",
        reason: "confirm new",
      });
      expect(claimNextIntent.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await session.close();
    });
  });
});

function responseFor(
  intentId: string,
  status: "parked",
  reason: string
): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: 1,
      outcome: { intentId, status, reason },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
