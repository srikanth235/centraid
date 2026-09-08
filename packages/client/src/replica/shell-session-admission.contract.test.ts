import { beforeAll, describe, expect, test, vi } from "vitest";

import type { IntentRecordStore } from "./intent-record-store.js";
import { MemoryIntentStore } from "./memory-intent-store.js";
import type * as TypeImport_1vwuba6 from "./shell-session.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import type { ReplicaIntent } from "./types.js";

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

  /**
   * THE OUTBOX IS THE SEAT'S NOW (#996, R24), so these claims are stated
   * against the store rather than a coordinator: the admission waiters sit
   * between `write` and the drain, and what the drain claims from is an
   * `IntentRecordStore`. A memory store stands in for the seat's file — the
   * ordering being pinned is the SESSION's, not the file's.
   */
  function outboxStore(
    overrides: Partial<IntentRecordStore> = {}
  ): IntentRecordStore {
    const store = new MemoryIntentStore();
    return Object.assign(store, overrides) as IntentRecordStore;
  }

  describe("ReplicaShellSession admission ordering", () => {
    test("connectivity loss after waiter registration resolves the write as durably queued", async () => {
      let phase: "start" | "write" = "start";
      let onlineChecks = 0;
      const queued = queuedIntent("offline-race");
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        {
          intentStore: outboxStore(),
          eventTarget: new EventTarget(),
          isOnline: () => phase === "write" && ++onlineChecks === 1,
        }
      );
      await session.start();
      phase = "write";

      await expect(
        session.write("todos", {
          intentId: queued.intentId,
          action: queued.action,
          input: queued.input,
        })
      ).resolves.toStrictEqual({
        intentId: queued.intentId,
        status: "queued",
        reason: "saved locally; waiting for a connection",
      });
      await session.close();
    });

    test("an unreadable outbox rejects every registered admission waiter", async () => {
      let online = false;
      const queued = queuedIntent("claim-failed");
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        {
          intentStore: outboxStore({
            claimNext: vi
              .fn<IntentRecordStore["claimNext"]>()
              .mockRejectedValue(new Error("the outbox is unreadable")),
          }),
          eventTarget: new EventTarget(),
          isOnline: () => online,
        }
      );
      await session.start();
      online = true;

      await expect(
        session.write("todos", {
          intentId: queued.intentId,
          action: queued.action,
          input: queued.input,
        })
      ).rejects.toThrow("the outbox is unreadable");
      await session.close();
    });

    test("fans one same-id admission result out to every concurrent writer", async () => {
      let online = false;
      const queued = queuedIntent("shared-intent");
      const fetcher = vi
        .fn<ReplicaFetcher>()
        .mockResolvedValue(
          responseFor(queued.intentId, "parked", "confirm first")
        );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        {
          intentStore: outboxStore(),
          fetcher,
          eventTarget: new EventTarget(),
          isOnline: () => online,
        }
      );
      await session.start();
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
      const duplicateAdd = deferred<ReplicaIntent>();
      const post = deferred<Response>();
      const store = new MemoryIntentStore();
      const add = vi
        .fn<IntentRecordStore["add"]>()
        .mockImplementationOnce((intent) => store.add(intent))
        .mockReturnValueOnce(duplicateAdd.promise);
      const claimNext = vi.fn<IntentRecordStore["claimNext"]>(() =>
        store.claimNext()
      );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        {
          intentStore: outboxStore({ add, claimNext }),
          fetcher: vi.fn<ReplicaFetcher>().mockReturnValue(post.promise),
          eventTarget: new EventTarget(),
          isOnline: () => online,
        }
      );
      await session.start();
      online = true;

      const first = session.write("todos", {
        intentId: queued.intentId,
        action: queued.action,
        input: queued.input,
      });
      await vi.waitFor(() => expect(claimNext).toHaveBeenCalledWith());
      const duplicate = session.write("todos", {
        intentId: queued.intentId,
        action: queued.action,
        input: queued.input,
      });
      await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2));

      post.resolve(responseFor(queued.intentId, "parked", "confirm first"));
      duplicateAdd.resolve({ ...queued, state: "sending" });

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
      const addGate = deferred<ReplicaIntent>();
      const previousPost = deferred<Response>();
      const claimNext = vi
        .fn<IntentRecordStore["claimNext"]>()
        .mockResolvedValueOnce(previous)
        .mockResolvedValueOnce(queued)
        .mockResolvedValue(undefined);
      /** Every answer the drain wrote back, settled or transitioned. */
      const settled: ReplicaIntent[] = [];
      const store = outboxStore({
        add: vi.fn<IntentRecordStore["add"]>().mockReturnValue(addGate.promise),
        claimNext,
        // The claims above hand out intents the store never took an `add`
        // for, so `get` answers for them: the settlement path reads the
        // record before it writes the answer back.
        get: vi.fn<IntentRecordStore["get"]>(async (intentId) => ({
          ...queuedIntent(intentId),
          state: "sending",
        })),
        settle: vi.fn<IntentRecordStore["settle"]>(
          async (intentId, _allowed, patch) => {
            const record = { ...queuedIntent(intentId), ...patch };
            settled.push(record);
            return record;
          }
        ),
        transition: vi.fn<IntentRecordStore["transition"]>(
          async (intentId, _allowed, patch) => {
            const record = { ...queuedIntent(intentId), ...patch };
            settled.push(record);
            return record;
          }
        ),
      });
      const fetcher = vi
        .fn<ReplicaFetcher>()
        .mockReturnValueOnce(previousPost.promise)
        .mockResolvedValueOnce(
          responseFor(queued.intentId, "parked", "confirm new")
        );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        {
          intentStore: store,
          fetcher,
          eventTarget: new EventTarget(),
          isOnline: () => true,
        }
      );
      await session.start();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

      const result = session.write("todos", {
        intentId: queued.intentId,
        action: queued.action,
        input: queued.input,
      });
      await vi.waitFor(() => expect(store.add).toHaveBeenCalledOnce());
      previousPost.resolve(
        responseFor(previous.intentId, "parked", "confirm previous")
      );
      await vi.waitFor(() => expect(settled).toHaveLength(1));
      expect(claimNext).toHaveBeenCalledOnce();

      addGate.resolve(queued);
      await expect(result).resolves.toStrictEqual({
        intentId: queued.intentId,
        status: "parked",
        reason: "confirm new",
      });
      expect(claimNext.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await session.close();
    });

    test("a severed gateway settles the writes behind the failed head, then drains each exactly once", async () => {
      let severed = true;
      const executed: string[] = [];
      // A durable, ordered outbox — the memory store IS one: the head keeps
      // its place across a failed attempt, which is what leaves later writes
      // unclaimed.
      const store = new MemoryIntentStore();
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
        {
          intentStore: store,
          fetcher,
          eventTarget,
          isOnline: () => true,
          retryDelayMs: 60_000,
        }
      );
      await session.start();

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
      expect((await store.list()).map((intent) => intent.state)).toStrictEqual([
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
