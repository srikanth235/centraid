// governance: allow-repo-hygiene file-size-limit pre-existing cohesive session regression suite; decomposition is outside issue #417
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, test, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type {
  ReplicaShellSessionOptions,
  ShellReplicaCoordinator,
} from "./shell-session.js";
import type * as TypeImport_1vwuba6 from "./shell-session.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import {
  listRememberedReplicaIdentities,
  rememberReplicaIdentity,
} from "./storage-manifest.js";
import type {
  ReplicaIntent,
  ReplicaInvalidation,
  ReplicaShape,
} from "./types.js";

let ReplicaShellSession: typeof TypeImport_1vwuba6.ReplicaShellSession;
let replicaIdentityForGatewayAuth: typeof TypeImport_1vwuba6.replicaIdentityForGatewayAuth;
let purgeCurrentReplicaDevice: typeof TypeImport_1vwuba6.purgeCurrentReplicaDevice;

describe("shell-session", () => {
  beforeAll(async () => {
    Object.assign(window, {
      CentraidApi: {
        getGatewayAuth: () =>
          Promise.resolve({
            baseUrl: "https://gateway.example",
            gatewayId: "profile-home",
            vaultId: "vault",
            rememberDevice: false,
          }),
        onGatewayChanged: () => () => undefined,
        onVaultChanged: () => () => undefined,
      },
    });
    ({
      ReplicaShellSession,
      purgeCurrentReplicaDevice,
      replicaIdentityForGatewayAuth,
    } = await import("./shell-session.js"));
  });

  const shapes: ReplicaShape[] = [
    {
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
    },
    {
      shapeId: "shape-notes",
      appId: "notes",
      purpose: "dpv:ServiceProvision",
      entities: [
        {
          entity: "core.note",
          primaryKey: "note_id",
          columns: ["note_id", "title"],
        },
      ],
    },
    {
      shapeId: "shape-todos-billing",
      appId: "todos",
      purpose: "dpv:Billing",
      entities: [
        {
          entity: "core.task",
          primaryKey: "task_id",
          columns: ["task_id", "cost"],
        },
      ],
    },
  ];

  function intent(): ReplicaIntent {
    return {
      intentId: "intent-1",
      payloadHash: "a".repeat(64),
      appId: "todos",
      action: "complete",
      input: { taskId: "task-1" },
      state: "sending",
      createdOrder: 1,
      attempts: 1,
      optimistic: [],
    };
  }

  function fakeCoordinator(
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
        .mockResolvedValue(shapes),
      readWire: vi.fn<ShellReplicaCoordinator["readWire"]>().mockResolvedValue({
        rows: [],
        cursor: { epoch: "e", seq: 1 },
        dependency: { shapeId: "shape-todos", entity: "core.task" },
      }),
      searchWire: vi
        .fn<ShellReplicaCoordinator["searchWire"]>()
        .mockResolvedValue({
          rows: [],
          cursor: { epoch: "e", seq: 1 },
          dependency: { shapeId: "shape-todos", entity: "core.task" },
        }),
      enqueue: vi
        .fn<ShellReplicaCoordinator["enqueue"]>()
        .mockResolvedValue(intent()),
      claimNextIntent: vi
        .fn<ShellReplicaCoordinator["claimNextIntent"]>()
        .mockResolvedValue(undefined),
      markIntentTransportFailed: vi
        .fn<ShellReplicaCoordinator["markIntentTransportFailed"]>()
        .mockResolvedValue(intent()),
      markIntentAwaitingChange: vi
        .fn<ShellReplicaCoordinator["markIntentAwaitingChange"]>()
        .mockResolvedValue(intent()),
      applyIntentOutcome: vi
        .fn<ShellReplicaCoordinator["applyIntentOutcome"]>()
        .mockResolvedValue(intent()),
      recoverSending: vi
        .fn<ShellReplicaCoordinator["recoverSending"]>()
        .mockResolvedValue([]),
      pendingIntents: vi
        .fn<ShellReplicaCoordinator["pendingIntents"]>()
        .mockResolvedValue([]),
      attentionIntents: vi
        .fn<ShellReplicaCoordinator["attentionIntents"]>()
        .mockResolvedValue([]),
      dismissAttentionIntent: vi
        .fn<ShellReplicaCoordinator["dismissAttentionIntent"]>()
        .mockResolvedValue(false),
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

  describe("ReplicaShellSession", () => {
    test("keys storage by stable gateway identity rather than a transient transport URL", () => {
      expect(
        replicaIdentityForGatewayAuth({
          baseUrl: "http://127.0.0.1:49152",
          gatewayId: "profile-home",
          vaultId: "vault",
        })
      ).toStrictEqual({ gatewayId: "profile-home", vaultId: "vault" });
      expect(
        replicaIdentityForGatewayAuth({
          baseUrl: "https://EXAMPLE.test/root/?temporary=1",
          vaultId: "vault",
        })
      ).toStrictEqual({
        gatewayId: "url:https://example.test/root",
        vaultId: "vault",
      });
    });

    test("self-revoke cleanup eagerly purges browser replica caches without an open session", async () => {
      localStorage.clear();
      const deleteCache = vi
        .fn<(cacheName: string) => Promise<boolean>>()
        .mockResolvedValue(true);
      const postMessage = vi.fn<(message: unknown) => void>();
      const priorCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
      const priorServiceWorker = Object.getOwnPropertyDescriptor(
        navigator,
        "serviceWorker"
      );
      Object.defineProperty(globalThis, "caches", {
        configurable: true,
        value: {
          keys: vi
            .fn<() => Promise<string[]>>()
            .mockResolvedValue([
              "centraid-tunnel-assets-device",
              "unrelated-cache",
            ]),
          delete: deleteCache,
        },
      });
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { controller: { postMessage } },
      });
      try {
        await purgeCurrentReplicaDevice();
        await vi.waitFor(() =>
          expect(deleteCache).toHaveBeenCalledWith(
            "centraid-tunnel-assets-device"
          )
        );
        expect(deleteCache).not.toHaveBeenCalledWith("unrelated-cache");
        expect(postMessage).toHaveBeenCalledWith({
          type: "centraid:purge-tunnel-cache",
        });
      } finally {
        if (priorCaches)
          Object.defineProperty(globalThis, "caches", priorCaches);
        else Reflect.deleteProperty(globalThis, "caches");
        if (priorServiceWorker)
          Object.defineProperty(navigator, "serviceWorker", priorServiceWorker);
        else Reflect.deleteProperty(navigator, "serviceWorker");
        localStorage.clear();
      }
    });

    test("sync() pulls the coordinator to the gateway head once a cursor exists", async () => {
      const syncNow = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const coordinator = fakeCoordinator({
        status: vi.fn<ShellReplicaCoordinator["status"]>().mockResolvedValue({
          mode: "memory",
          cursor: { epoch: "e", seq: 1 },
          schemaEpoch: "schema",
          coverage: "complete",
        }),
        syncNow,
      });
      const session = new ReplicaShellSession(
        {
          baseUrl: "http://127.0.0.1:49152",
          gatewayId: "profile-home",
          vaultId: "vault",
        },
        coordinator,
        { eventTarget: new EventTarget(), isOnline: () => true }
      );
      await session.start(await coordinator.status());

      await session.sync();

      expect(syncNow).toHaveBeenCalledOnce();
      await session.close();
    });

    test("sync() before the first fill defers to bootstrap rather than pulling", async () => {
      const syncNow = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const coordinator = fakeCoordinator({ syncNow });
      const session = new ReplicaShellSession(
        {
          baseUrl: "http://127.0.0.1:49152",
          gatewayId: "profile-home",
          vaultId: "vault",
        },
        coordinator,
        // Offline, so the deferred bootstrap parks instead of fetching — the
        // point here is only that a cursor-less replica never pulls changes.
        { eventTarget: new EventTarget(), isOnline: () => false }
      );
      await session.start(await coordinator.status());

      await session.sync();

      expect(syncNow).not.toHaveBeenCalled();
      await session.close();
    });

    test("closing for a gateway switch preserves remembered storage for a warm return", async () => {
      localStorage.clear();
      const identity = { gatewayId: "profile-home", vaultId: "vault" };
      rememberReplicaIdentity(identity);
      const coordinator = fakeCoordinator();
      const session = new ReplicaShellSession(
        {
          baseUrl: "http://127.0.0.1:49152",
          gatewayId: identity.gatewayId,
          vaultId: identity.vaultId,
          rememberDevice: true,
        },
        coordinator,
        {
          eventTarget: new EventTarget(),
          isOnline: () => false,
          rememberStorage: true,
        }
      );

      await session.close();

      expect(coordinator.close).toHaveBeenCalledOnce();
      expect(coordinator.purge).toHaveBeenCalledTimes(0);
      expect(listRememberedReplicaIdentities()).toStrictEqual([identity]);
      localStorage.clear();
    });

    test("terminal scope purge forgets the durable manifest only after storage is wiped", async () => {
      localStorage.clear();
      const cursorKey = `centraid:vault-change-cursor:${encodeURIComponent("profile-home\u0000vault")}`;
      sessionStorage.setItem(
        cursorKey,
        JSON.stringify({ epoch: "old", seq: 9 })
      );
      const identity = { gatewayId: "profile-home", vaultId: "vault" };
      rememberReplicaIdentity(identity);
      const coordinator = fakeCoordinator();
      const session = new ReplicaShellSession(
        {
          baseUrl: "http://127.0.0.1:49152",
          gatewayId: identity.gatewayId,
          vaultId: identity.vaultId,
          rememberDevice: true,
        },
        coordinator,
        {
          eventTarget: new EventTarget(),
          isOnline: () => false,
          rememberStorage: true,
        }
      );

      await session.purge();

      expect(coordinator.purge).toHaveBeenCalledOnce();
      expect(listRememberedReplicaIdentities()).toStrictEqual([]);
      expect(sessionStorage.getItem(cursorKey)).toBeNull();
    });

    test("purge after close still clears terminal scope state", async () => {
      const cursorKey = `centraid:vault-change-cursor:${encodeURIComponent("profile-home\u0000vault")}`;
      sessionStorage.setItem(
        cursorKey,
        JSON.stringify({ epoch: "old", seq: 9 })
      );
      const coordinator = fakeCoordinator();
      const session = new ReplicaShellSession(
        {
          baseUrl: "https://gateway.example",
          gatewayId: "profile-home",
          vaultId: "vault",
          rememberDevice: false,
        },
        coordinator,
        {
          eventTarget: new EventTarget(),
          isOnline: () => false,
          rememberStorage: false,
        }
      );

      await session.close();
      await session.purge();

      expect(sessionStorage.getItem(cursorKey)).toBeNull();
    });

    test("keeps the manifest entry when terminal storage purge fails", async () => {
      localStorage.clear();
      const identity = { gatewayId: "profile-home", vaultId: "vault" };
      rememberReplicaIdentity(identity);
      const session = new ReplicaShellSession(
        {
          baseUrl: "http://127.0.0.1:49152",
          gatewayId: identity.gatewayId,
          vaultId: identity.vaultId,
          rememberDevice: true,
        },
        fakeCoordinator({
          purge: vi
            .fn<ShellReplicaCoordinator["purge"]>()
            .mockRejectedValue(new Error("OPFS busy")),
        }),
        {
          eventTarget: new EventTarget(),
          isOnline: () => false,
          rememberStorage: true,
        }
      );

      await expect(session.purge()).rejects.toThrow("OPFS busy");
      expect(listRememberedReplicaIdentities()).toStrictEqual([identity]);
      localStorage.clear();
    });

    test("reuses a warm catalog, maps app entities and filters subscription invalidations", async () => {
      let emit: ((values: readonly ReplicaInvalidation[]) => void) | undefined;
      const listener =
        vi.fn<(invalidations: readonly ReplicaInvalidation[]) => void>();
      const coordinator = fakeCoordinator({
        subscribeInvalidations: vi.fn<
          ShellReplicaCoordinator["subscribeInvalidations"]
        >((next) => {
          emit = next;
          return () => undefined;
        }),
      });
      const session = new ReplicaShellSession(
        {
          baseUrl: "https://gateway.example",
          vaultId: "vault",
          rememberDevice: true,
        },
        coordinator,
        { eventTarget: new EventTarget(), isOnline: () => false }
      );
      await session.start({
        mode: "opfs-sahpool",
        cursor: { epoch: "warm", seq: 42 },
        schemaEpoch: "schema",
      });
      expect(coordinator.bootstrap).toHaveBeenCalledTimes(0);
      await session.read("todos", { entity: "core.task" });
      expect(coordinator.readWire).toHaveBeenCalledWith({
        shapeId: "shape-todos",
        entity: "core.task",
      });
      await session.read("todos", {
        entity: "core.task",
        purpose: "dpv:Billing",
      });
      expect(coordinator.readWire).toHaveBeenLastCalledWith({
        shapeId: "shape-todos-billing",
        entity: "core.task",
        purpose: "dpv:Billing",
      });
      await session.search("todos", { entity: "core.task", query: "local" });
      expect(coordinator.searchWire).toHaveBeenCalledWith({
        shapeId: "shape-todos",
        entity: "core.task",
        query: "local",
      });

      session.subscribe("todos", [{ entity: "core.task" }], listener);
      emit?.([
        { shapeId: "shape-notes", entity: "core.note", source: "canonical" },
        {
          shapeId: "shape-todos-billing",
          entity: "core.task",
          source: "canonical",
        },
        { shapeId: "shape-todos", entity: "core.task", source: "canonical" },
      ]);
      expect(listener).toHaveBeenCalledWith([
        {
          shapeId: "shape-todos-billing",
          entity: "core.task",
          source: "canonical",
        },
        { shapeId: "shape-todos", entity: "core.task", source: "canonical" },
      ]);
      const billingListener =
        vi.fn<(invalidations: readonly ReplicaInvalidation[]) => void>();
      session.subscribe(
        "todos",
        [{ shapeId: "shape-todos-billing", entity: "core.task" }],
        billingListener
      );
      emit?.([
        { shapeId: "shape-todos", entity: "core.task", source: "canonical" },
        {
          shapeId: "shape-todos-billing",
          entity: "core.task",
          source: "canonical",
        },
      ]);
      expect(billingListener).toHaveBeenCalledWith([
        {
          shapeId: "shape-todos-billing",
          entity: "core.task",
          source: "canonical",
        },
      ]);
      await session.purge();
    });

    test("retries a transient bootstrap failure without waiting for an online event", async () => {
      const clock = useFakeClock();
      const coordinator = fakeCoordinator();
      const fetcher = vi
        .fn<ReplicaFetcher>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "gateway_error" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              vaultId: "vault",
              schemaEpoch: "schema",
              cursor: { epoch: "epoch", seq: 7 },
              shapes: [],
              rows: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        coordinator,
        {
          fetcher,
          eventTarget: new EventTarget(),
          isOnline: () => true,
          retryDelayMs: 10,
        }
      );

      await session.start({
        mode: "memory",
        cursor: null,
        schemaEpoch: null,
      });
      expect(coordinator.bootstrap).toHaveBeenCalledTimes(0);
      await clock.advance(10);
      await vi.waitFor(() =>
        expect(coordinator.bootstrap).toHaveBeenCalledOnce()
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
      await session.close();
    });

    test("ships an idempotent intent and keeps its overlay until canonical execution arrives", async () => {
      const queued = intent();
      const claimNextIntent = vi
        .fn<() => Promise<ReplicaIntent | undefined>>()
        .mockResolvedValueOnce(queued)
        .mockResolvedValue(undefined);
      const coordinator = fakeCoordinator({ claimNextIntent });
      const fetcher = vi.fn<ReplicaFetcher>().mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            outcome: { intentId: queued.intentId, status: "executed" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        coordinator,
        { fetcher, eventTarget: new EventTarget(), isOnline: () => true }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      await session.flushIntents();
      expect(JSON.parse(String(fetcher.mock.calls[0]![2].body))).toStrictEqual({
        intentId: queued.intentId,
        appId: queued.appId,
        action: queued.action,
        input: queued.input,
        payloadHash: queued.payloadHash,
      });
      expect(coordinator.markIntentAwaitingChange).toHaveBeenCalledWith(
        queued.intentId
      );
      expect(coordinator.applyIntentOutcome).toHaveBeenCalledTimes(0);
      await session.close();
    });

    test("returns a durable queued acknowledgement immediately while offline", async () => {
      const coordinator = fakeCoordinator();
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        coordinator,
        { eventTarget: new EventTarget(), isOnline: () => false }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });

      await expect(
        session.write("todos", {
          action: "complete",
          input: { taskId: "task-1" },
          optimistic: [
            {
              op: "upsert",
              entity: "core.task",
              rowId: "task-1",
              values: { cost: 42 },
              purpose: "dpv:Billing",
            },
          ],
        })
      ).resolves.toStrictEqual({
        intentId: "intent-1",
        status: "queued",
        reason: "waiting for a connection",
      });
      expect(coordinator.enqueue).toHaveBeenCalledWith({
        appId: "todos",
        action: "complete",
        input: { taskId: "task-1" },
        dependencies: [
          { shapeId: "shape-todos", entity: "core.task" },
          { shapeId: "shape-todos-billing", entity: "core.task" },
        ],
        optimistic: [
          {
            op: "upsert",
            shapeId: "shape-todos-billing",
            entity: "core.task",
            rowId: "task-1",
            values: { cost: 42 },
          },
        ],
      });
      expect(coordinator.claimNextIntent).toHaveBeenCalledTimes(0);
      await session.close();
    });

    test("returns the gateway admission outcome for an online write", async () => {
      let online = false;
      const queued = intent();
      const coordinator = fakeCoordinator({
        claimNextIntent: vi
          .fn<() => Promise<ReplicaIntent | undefined>>()
          .mockResolvedValueOnce(queued)
          .mockResolvedValue(undefined),
      });
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        coordinator,
        {
          eventTarget: new EventTarget(),
          isOnline: () => online,
          fetcher: vi.fn<ReplicaFetcher>().mockResolvedValue(
            new Response(
              JSON.stringify({
                protocolVersion: 1,
                outcome: {
                  intentId: queued.intentId,
                  status: "parked",
                  reason: "confirm first",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          ),
        }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      online = true;

      await expect(
        session.write("todos", {
          action: "complete",
          input: { taskId: "task-1" },
        })
      ).resolves.toStrictEqual({
        intentId: "intent-1",
        status: "parked",
        reason: "confirm first",
      });
      expect(coordinator.applyIntentOutcome).toHaveBeenCalledWith({
        intentId: "intent-1",
        status: "parked",
        reason: "confirm first",
      });
      await session.close();
    });

    test("an online event keeps a warm cursor instead of re-downloading bootstrap", async () => {
      const events = new EventTarget();
      const coordinator = fakeCoordinator();
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        coordinator,
        { eventTarget: events, isOnline: () => true }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "warm", seq: 7 },
        schemaEpoch: "s",
      });

      events.dispatchEvent(new Event("online"));
      await Promise.resolve();
      expect(coordinator.bootstrap).toHaveBeenCalledTimes(0);
      await session.close();
    });

    test("reruns an active drain when an enqueue races its empty claim", async () => {
      let releaseEmptyClaim: (() => void) | undefined;
      const emptyClaim = new Promise<undefined>((resolve) => {
        releaseEmptyClaim = () => resolve(undefined);
      });
      const queued = intent();
      const claimNextIntent = vi
        .fn<() => Promise<ReplicaIntent | undefined>>()
        .mockReturnValueOnce(emptyClaim)
        .mockResolvedValueOnce(queued)
        .mockResolvedValue(undefined);
      const coordinator = fakeCoordinator({ claimNextIntent });
      const fetcher = vi.fn<ReplicaFetcher>().mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            outcome: {
              intentId: queued.intentId,
              status: "parked",
              reason: "confirm first",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        coordinator,
        { fetcher, eventTarget: new EventTarget(), isOnline: () => true }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      expect(claimNextIntent).toHaveBeenCalledOnce();

      const result = session.write("todos", {
        action: queued.action,
        input: queued.input,
      });
      await vi.waitFor(() =>
        expect(coordinator.enqueue).toHaveBeenCalledOnce()
      );
      releaseEmptyClaim?.();

      await expect(result).resolves.toStrictEqual({
        intentId: queued.intentId,
        status: "parked",
        reason: "confirm first",
      });
      expect(claimNextIntent).toHaveBeenCalledTimes(3);
      await session.close();
    });

    test("purges OPFS and IDB state when the gateway revokes authorization", async () => {
      const coordinator = fakeCoordinator({
        claimNextIntent: vi
          .fn<() => Promise<ReplicaIntent | undefined>>()
          .mockResolvedValueOnce(intent())
          .mockResolvedValue(undefined),
      });
      const revoked =
        vi.fn<
          NonNullable<ReplicaShellSessionOptions["onAuthorizationRevoked"]>
        >();
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        coordinator,
        {
          fetcher: vi.fn<ReplicaFetcher>().mockResolvedValue(
            new Response(
              JSON.stringify({ error: "replica_device_not_enrolled" }),
              {
                status: 403,
              }
            )
          ),
          eventTarget: new EventTarget(),
          isOnline: () => true,
          onAuthorizationRevoked: revoked,
        }
      );
      await session.start({
        mode: "memory",
        cursor: { epoch: "e", seq: 1 },
        schemaEpoch: "s",
      });
      await session.flushIntents();
      expect(revoked).toHaveBeenCalledWith(session);
      expect(coordinator.purge).toHaveBeenCalledOnce();
    });

    test("a rebootstrap demanded mid-bootstrap runs after it, instead of being dropped", async () => {
      let releaseBootstrap: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseBootstrap = () => resolve();
      });
      const coordinator = fakeCoordinator({
        bootstrap: vi
          .fn<ShellReplicaCoordinator["bootstrap"]>()
          .mockImplementationOnce(async () => {
            await gate;
            return { epoch: "epoch", seq: 7 };
          })
          .mockResolvedValue({ epoch: "epoch", seq: 8 }),
      });
      // A fresh Response per call: both bootstraps read the body.
      const fetcher = vi.fn<ReplicaFetcher>().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              vaultId: "vault",
              schemaEpoch: "schema",
              cursor: { epoch: "epoch", seq: 7 },
              shapes: [],
              rows: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      );
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        coordinator,
        { fetcher, eventTarget: new EventTarget(), isOnline: () => true }
      );

      const started = session.start({
        mode: "memory",
        cursor: null,
        schemaEpoch: null,
      });
      await vi.waitFor(() =>
        expect(coordinator.bootstrap).toHaveBeenCalledOnce()
      );
      // The gateway rejects the state this walk began from, while it walks.
      session.requireBootstrap();
      releaseBootstrap?.();
      await started;

      await vi.waitFor(() =>
        expect(coordinator.bootstrap).toHaveBeenCalledTimes(2)
      );
      await session.close();
    });
  });
  // The windowed-bootstrap `target` hands the coordinator's own methods to
  // `runWindowedBootstrap`, which invokes them as `target.bootstrapBegin(...)`.
  // A bare method reference therefore arrives with `this` bound to the object
  // literal, and `bootstrapBegin` calls a private method on itself as its very
  // first act — so detaching them threw `this.resetFeedGeneration is not a
  // function` on any vault large enough to take the windowed path. Unit tests
  // stayed green because nothing here drives a real windowed bootstrap; it
  // surfaced only when the desktop Home springboard began reading the replica.
  //
  // This is a STRUCTURAL guard, not a behavioural one: a windowed-bootstrap
  // fixture does not exist yet, so this pins the shape of the call site until
  // one does.
  describe("windowed bootstrap target", () => {
    test("passes coordinator methods wrapped, never as detached references", () => {
      const source = readFileSync(
        path.join(import.meta.dirname, "shell-session.ts"),
        "utf8"
      );
      const target = /target:\s*\{(?<body>[\s\S]*?)\n\s{8}\}/u.exec(source)
        ?.groups?.body;
      expect(target, "windowed-bootstrap target literal not found").toBeTypeOf(
        "string"
      );
      // A bare `this.coordinator.foo!,` or `this.coordinator.foo,` entry is the
      // regression; every method must be reached through an arrow that keeps
      // the coordinator as the receiver.
      expect(target).not.toMatch(/:\s*this\.coordinator\.\w+!?,/u);
      expect(target).toMatch(/[=]>\s*this\.coordinator\.bootstrapBegin!\(/u);
    });

    // The second way this literal goes wrong, and the one the compiler cannot
    // see: a function that accepts FEWER parameters than its target type is
    // assignable in TypeScript, so a wrapper that quietly drops an argument
    // typechecks. `bootstrapCommit(cursor, header, outcomes)` wrapped as
    // `(cursor, header) => ...` compiled clean while discarding the intent
    // outcomes reconciled against the page-1 cursor — every write in flight
    // across a bootstrap was left unresolved with nothing to report it.
    test("forwards every parameter each wrapper declares", () => {
      const source = readFileSync(
        path.join(import.meta.dirname, "shell-session.ts"),
        "utf8"
      );
      const target = /target:\s*\{(?<body>[\s\S]*?)\n\s{8}\}/u.exec(source)
        ?.groups?.body;
      const wrappers = [
        ...(target ?? "").matchAll(
          /\((?<params>[^)]*)\)\s*=>\s*this\.coordinator\.(?<method>\w+)!?\((?<args>[^)]*)\)/gu
        ),
      ];
      expect(wrappers.length).toBeGreaterThanOrEqual(5);
      const names = (list: string): string[] =>
        list
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
      for (const wrapper of wrappers) {
        const { args, method, params } = wrapper.groups!;
        expect(
          names(args!),
          `${method} drops or reorders a parameter`
        ).toStrictEqual(names(params!));
      }
    });
  });
});
