// THE SHELL'S SESSION, OVER A SEAT (#996, W5).
//
// WHAT THIS SUITE STOPPED BEING ABOUT. It used to drive a COORDINATOR: a
// shaped store behind a worker, a catalog of shapes, a windowed bootstrap that
// could stop half-way, and a declarative read grammar the session resolved
// against that catalog. None of that exists — a seat is the vault's own file,
// a page is a statement, and the outbox is a table inside the same file — so
// the claims that were about the coordinator's plumbing went with it.
//
// WHAT IS LEFT, AND WHERE. This file holds the two rails that are about the
// BROWSER: storage keyed by a DURABLE identity rather than a transport URL,
// terminal purge that forgets the manifest only once storage is gone, and a
// read rail that REFUSES rather than answers when this browser holds no copy
// (W4-D2, R9). The write rail — idempotent posts, the durable queued answer,
// revision over a second write, admission — is `shell-session-writes.test.ts`.
import { beforeAll, describe, expect, test, vi } from "vitest";

import { MemoryIntentStore } from "./memory-intent-store.js";
import type * as TypeImport_identity from "./replica-identity.js";
import type * as TypeImport_scopes from "./shell-session-scopes.js";
import type * as TypeImport_1vwuba6 from "./shell-session.js";
import {
  cursorKey,
  installGatewayApiStub,
  intent,
  options,
  outcomeResponse,
} from "./shell-session.test-fixtures.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import {
  listRememberedReplicaIdentities,
  rememberReplicaIdentity,
} from "./storage-manifest.js";
import type { ReplicaInvalidation } from "./types.js";

let ReplicaShellSession: typeof TypeImport_1vwuba6.ReplicaShellSession;
let replicaIdentityForGatewayAuth: typeof TypeImport_identity.replicaIdentityForGatewayAuth;
let purgeCurrentReplicaDevice: typeof TypeImport_scopes.purgeCurrentReplicaDevice;

describe("shell-session", () => {
  beforeAll(async () => {
    installGatewayApiStub();
    ({ ReplicaShellSession } = await import("./shell-session.js"));
    ({ replicaIdentityForGatewayAuth } = await import("./replica-identity.js"));
    ({ purgeCurrentReplicaDevice } = await import("./shell-session-scopes.js"));
  });

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

    test("closing for a gateway switch preserves remembered storage for a warm return", async () => {
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
        options({ rememberStorage: true })
      );

      await session.close();

      // A switch is not a revoke: the file stays, and so does the manifest
      // entry that says this browser holds one.
      expect(listRememberedReplicaIdentities()).toStrictEqual([identity]);
      localStorage.clear();
    });

    test("terminal scope purge forgets the durable manifest only after storage is wiped", async () => {
      localStorage.clear();
      sessionStorage.setItem(
        cursorKey(),
        JSON.stringify({ epoch: "old", seq: 9 })
      );
      const identity = { gatewayId: "profile-home", vaultId: "vault" };
      rememberReplicaIdentity(identity);
      const session = new ReplicaShellSession(
        {
          baseUrl: "http://127.0.0.1:49152",
          gatewayId: identity.gatewayId,
          vaultId: identity.vaultId,
          rememberDevice: true,
        },
        options({ rememberStorage: true })
      );

      await session.purge();

      expect(listRememberedReplicaIdentities()).toStrictEqual([]);
      expect(sessionStorage.getItem(cursorKey())).toBeNull();
    });

    test("purge after close still clears terminal scope state", async () => {
      sessionStorage.setItem(
        cursorKey(),
        JSON.stringify({ epoch: "old", seq: 9 })
      );
      const session = new ReplicaShellSession(
        {
          baseUrl: "https://gateway.example",
          gatewayId: "profile-home",
          vaultId: "vault",
          rememberDevice: false,
        },
        options()
      );

      await session.close();
      await session.purge();

      expect(sessionStorage.getItem(cursorKey())).toBeNull();
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
        options({
          rememberStorage: true,
          // The manifest is the record of what this browser still holds; a
          // purge that could not reach the storage must leave it standing, or
          // the file is orphaned with nothing naming it.
          inventory: {
            activate: () => Promise.reject(new Error("IDB unavailable")),
            markTerminal: () => Promise.reject(new Error("IDB unavailable")),
            deferTerminal: () => Promise.reject(new Error("IDB unavailable")),
            remove: () => Promise.reject(new Error("IDB unavailable")),
            list: () => Promise.reject(new Error("IDB unavailable")),
          },
        })
      );

      await expect(session.purge()).rejects.toThrow(/IDB unavailable/u);
      expect(listRememberedReplicaIdentities()).toStrictEqual([identity]);
      localStorage.clear();
    });

    test("a seat with no copy refuses reads instead of answering them empty", async () => {
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        options()
      );
      await session.start();

      // SEARCH IS THE SEAT'S NOW (#996, ruling W5-D1) and so is every page.
      // No file means ONLINE_ONLY, and the caller re-runs the whole query on
      // the gateway's paged door — an empty answer would be a lie about the
      // vault (W4-D2, R9).
      await expect(
        session.search("todos", { entity: "schedule.task", query: "local" })
      ).rejects.toThrow(/online/iu);
      await expect(
        session.page(
          {
            name: "tasks.board",
            select: "*",
            from: "schedule_task",
            order: {
              sortColumn: "task_id",
              pkColumn: "task_id",
              descending: false,
            },
          },
          { limit: 10 }
        )
      ).rejects.toThrow(/online/iu);
      await session.close();
    });

    test("invalidates by entity, and only for the entities a screen asked about", async () => {
      const listener =
        vi.fn<(invalidations: readonly ReplicaInvalidation[]) => void>();
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        options()
      );
      await session.start();
      session.subscribe("todos", [{ entity: "schedule.task" }], listener);

      // A WRITE IS AN INVALIDATION. Its dependency set is the entities the
      // write touched — one task edited used to invalidate the whole app,
      // because a shape was the smallest thing the old plane could name.
      await session.write("todos", {
        intentId: "intent-task",
        action: "edit",
        input: { task_id: "task-1" },
        optimistic: [
          {
            op: "upsert",
            entity: "schedule.task",
            rowId: "task-1",
            values: { task_id: "task-1", title: "Edited" },
          },
        ],
      });
      // The listener fired, and every invalidation it was told about is about
      // ITS entity — one list proves both.
      expect(
        listener.mock.calls
          .flatMap(([values]) => values)
          .map((invalidation) => invalidation.entity)
      ).toStrictEqual(["schedule.task", "schedule.task"]);

      listener.mockClear();
      await session.write("notes", {
        intentId: "intent-note",
        action: "edit",
        input: { note_id: "note-1" },
        optimistic: [
          {
            op: "upsert",
            entity: "knowledge.note",
            rowId: "note-1",
            values: { note_id: "note-1" },
          },
        ],
      });
      expect(listener).not.toHaveBeenCalled();
      await session.close();
    });

    test("ships an idempotent intent and keeps its overlay until canonical execution arrives", async () => {
      const store = new MemoryIntentStore();
      const queued = await store.add({ ...intent(), state: "queued" });
      const fetcher = vi
        .fn<ReplicaFetcher>()
        .mockResolvedValue(outcomeResponse(queued.intentId, "executed"));
      const session = new ReplicaShellSession(
        { baseUrl: "https://gateway.example", vaultId: "vault" },
        options({ intentStore: store, fetcher, isOnline: () => true })
      );
      await session.start();
      await session.flushIntents();

      expect(JSON.parse(String(fetcher.mock.calls[0]![2].body))).toStrictEqual({
        intentId: queued.intentId,
        appId: queued.appId,
        action: queued.action,
        input: queued.input,
        payloadHash: queued.payloadHash,
      });
      // The overlay survives the ANSWER: it clears when the commit lands, not
      // when the gateway says it will (#929, R24).
      expect((await store.get(queued.intentId))?.state).toBe("awaiting-change");
      await session.close();
    });
  });
});
