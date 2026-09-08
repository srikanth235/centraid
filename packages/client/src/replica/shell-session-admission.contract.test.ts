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
      discardIntent: vi
        .fn<ShellReplicaCoordinator["discardIntent"]>()
        .mockResolvedValue(false),
      retryIntent: vi
        .fn<ShellReplicaCoordinator["retryIntent"]>()
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

    test("a severed gateway settles the writes behind the failed head, then drains each exactly once", async () => {
      let severed = true;
      const outbox: ReplicaIntent[] = [];
      const executed: string[] = [];
      const find = (intentId: string): ReplicaIntent => {
        const intent = outbox.find((item) => item.intentId === intentId);
        if (!intent) throw new Error(`Unknown intent ${intentId}`);
        return intent;
      };
      const replica = coordinator({
        // A durable, ordered outbox: the head keeps its place across a failed
        // attempt, which is what leaves later writes unclaimed.
        enqueue: vi.fn<ShellReplicaCoordinator["enqueue"]>(async (input) => {
          const intent: ReplicaIntent = {
            ...queuedIntent(input.intentId ?? "unnamed"),
            action: input.action,
            input: input.input,
            createdOrder: outbox.length + 1,
          };
          outbox.push(intent);
          return { ...intent };
        }),
        claimNextIntent: vi.fn<ShellReplicaCoordinator["claimNextIntent"]>(
          async () => {
            const next = outbox.find((intent) => intent.state === "queued");
            if (!next) return undefined;
            next.state = "sending";
            next.attempts += 1;
            return { ...next };
          }
        ),
        markIntentTransportFailed: vi.fn<
          ShellReplicaCoordinator["markIntentTransportFailed"]
        >(async (intentId, reason) => {
          const intent = find(intentId);
          intent.state = "queued";
          intent.reason = reason;
          return { ...intent };
        }),
        markIntentAwaitingChange: vi.fn<
          ShellReplicaCoordinator["markIntentAwaitingChange"]
        >(async (intentId) => {
          const intent = find(intentId);
          intent.state = "awaiting-change";
          return { ...intent };
        }),
      });
      const fetcher = vi.fn<ReplicaFetcher>((_baseUrl, _pathname, init) => {
        // The harness severs the transport, not `navigator.onLine`: the tab
        // still believes it is online, so every write takes the drain path.
        if (severed) throw new TypeError("Harness gateway is unreachable");
        const intentId = (JSON.parse(String(init.body)) as { intentId: string })
          .intentId;
        executed.push(intentId);
        return Promise.resolve(responseFor(intentId, "executed"));
      });
      const eventTarget = new EventTarget();
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        replica,
        { fetcher, eventTarget, isOnline: () => true, retryDelayMs: 60_000 }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });

      const queuedReason =
        "saved locally; retrying when the gateway is reachable";
      const both = Promise.all([
        session.write("todos", {
          intentId: "rename-first",
          action: "rename",
          input: { title: "First" },
        }),
        session.write("todos", {
          intentId: "rename-second",
          action: "rename",
          input: { title: "Second" },
        }),
      ]);

      await expect(settledWithinTicks(both)).resolves.toStrictEqual([
        { intentId: "rename-first", status: "queued", reason: queuedReason },
        { intentId: "rename-second", status: "queued", reason: queuedReason },
      ]);
      expect(executed).toStrictEqual([]);

      severed = false;
      eventTarget.dispatchEvent(new Event("online"));

      await vi.waitFor(() =>
        expect(executed).toStrictEqual(["rename-first", "rename-second"])
      );
      expect(outbox.map((intent) => intent.state)).toStrictEqual([
        "awaiting-change",
        "awaiting-change",
      ]);
      await session.close();
    });
  });
});

function responseFor(
  intentId: string,
  status: "parked" | "executed",
  reason?: string
): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: 1,
      outcome: { intentId, status, ...(reason ? { reason } : {}) },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/**
 * Bound the wait in ticks, not seconds: the #846 measurement waited 30s for a
 * settlement that never came, and a slow settlement is the same defect.
 */
async function settledWithinTicks<T>(
  work: Promise<T>,
  turns = 3
): Promise<T | "never-settled"> {
  const sentinel = (async () => {
    for (let turn = 0; turn < turns; turn += 1)
      // oxlint-disable-next-line no-await-in-loop -- (#880) turns are sequential by definition
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    return "never-settled" as const;
  })();
  return Promise.race([work, sentinel]);
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
