/*
 * WHAT THE REPLICA ROUTES ARE AFTER #996 W5.
 *
 * Two doors, and this suite is what is left of the one that used to cover
 * seven. The bootstrap, windowed-bootstrap, row, checkpoint and outcome-
 * reconciliation doors are gone with the shaped plane they served — a seat
 * holds the vault's own file, so there is nothing to compose for it — and the
 * JSON changes page went with them. What remains is the INTENT door and the
 * change feed, which is now a wake: a seat that is told the gateway moved goes
 * and reads the log door for itself.
 */
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { currentReplicaLogState } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { runWithVaultContext, vaultContext } from "../serve/vault-context.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import type { ReplicaIntentDispatcher } from "./replica-intent-route.js";
import { makeReplicaRouteHandler } from "./replica-routes.js";

const CHANGES_PATH = "/centraid/_vault/changes";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

describe("replica-routes", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function fixture(): Promise<{
    plane: VaultPlane;
    handler: ReturnType<typeof makeReplicaRouteHandler>;
    unscopedHandler: ReturnType<typeof makeReplicaRouteHandler>;
  }> {
    const dir = await tempDir(`replica-routes-${crypto.randomUUID()}-`);
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    const enrollments = EnrollmentStore.open(path.join(dir, "gateway.db"));
    const vaults = { current: () => plane } as unknown as VaultRegistry;
    const unscopedHandler = makeReplicaRouteHandler(vaults, {
      enrollments,
      dispatchIntent: vi
        .fn<ReplicaIntentDispatcher>()
        .mockResolvedValue({ status: "executed" }),
      heartbeatMs: 5,
    });
    const fixtureDevice = "fixture-device";
    enrollments.enroll({
      endpointId: fixtureDevice,
      vaultIds: [plane.boot.vaultId],
      label: "Fixture device",
      rememberDevice: true,
    });
    const handler: typeof unscopedHandler = (req, res) =>
      vaultContext()?.deviceKey
        ? unscopedHandler(req, res)
        : runWithVaultContext(
            { vaultId: plane.boot.vaultId, deviceKey: fixtureDevice },
            () => unscopedHandler(req, res)
          );
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => plane.stop()
    );
    plane.recordAppInstall("agenda", {
      scopes: [{ schema: "schedule", table: "task", verbs: "read+act" }],
    });
    return { plane, handler, unscopedHandler };
  }

  function task(plane: VaultPlane, id: string, title: string): void {
    plane.db.vault
      .prepare(
        `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
       VALUES (?, ?, ?, 'needs-action', 0)`
      )
      .run(id, plane.boot.ownerPartyId, title);
  }

  function watermark(plane: VaultPlane): string {
    const { epoch, seq } = currentReplicaLogState(plane.db.vault).watermark;
    return encodeURIComponent(`${epoch}:${seq}`);
  }

  function request(
    url: string,
    init: { method?: string; body?: unknown; accept?: string } = {}
  ): IncomingMessage {
    const req = Readable.from(
      init.body === undefined ? [] : [JSON.stringify(init.body)]
    );
    return Object.assign(req, {
      url,
      method: init.method ?? "GET",
      headers: init.accept ? { accept: init.accept } : {},
    }) as unknown as IncomingMessage;
  }

  class MockResponse extends EventTarget {
    statusCode = 200;
    readonly headers = new Map<string, string>();
    body = "";
    onWrite?: (chunk: string) => void;

    on(type: string, listener: () => void): this {
      this.addEventListener(type, listener);
      return this;
    }

    off(type: string, listener: () => void): this {
      this.removeEventListener(type, listener);
      return this;
    }

    setHeader(name: string, value: string | number | readonly string[]): this {
      this.headers.set(
        name.toLowerCase(),
        Array.isArray(value) ? value.join(", ") : String(value)
      );
      return this;
    }

    flushHeaders(): void {}

    write(value: string | Buffer): boolean {
      const chunk = String(value);
      this.body += chunk;
      this.onWrite?.(chunk);
      return true;
    }

    end(value?: string | Buffer): this {
      if (value !== undefined) this.body += String(value);
      return this;
    }

    json<T>(): T {
      return JSON.parse(this.body) as T;
    }
  }

  test("the replica routes fail closed without an authenticated device identity", async () => {
    const { unscopedHandler } = await fixture();
    const res = new MockResponse();

    await unscopedHandler(
      request(CHANGES_PATH),
      res as unknown as ServerResponse
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: "replica_device_identity_required",
    });
  });

  test("the shaped changes page is gone, and the answer names the door that replaced it", async () => {
    const { plane, handler } = await fixture();
    task(plane, "task-1", "Already present");
    const res = new MockResponse();

    await handler(
      request(`${CHANGES_PATH}?since=${watermark(plane)}`),
      res as unknown as ServerResponse
    );

    expect(res.statusCode).toBe(410);
    expect(res.json<{ error: string; message: string }>()).toMatchObject({
      error: "replica_changes_removed",
    });
    // A 410 that does not say where to go is a dead end for whatever still
    // holds the old URL; the seat's log door is the whole answer.
    expect(res.json<{ message: string }>().message).toContain(
      "/centraid/_vault/seat/log"
    );
  });

  test("the tail wakes a seat when the gateway moves, and reports the cursor it moved to", async () => {
    const { plane, handler } = await fixture();
    const since = watermark(plane);
    task(plane, "task-doorbell", "SSE doorbell");
    const req = request(`${CHANGES_PATH}?since=${since}&stream=1`, {
      accept: "text/event-stream",
    });
    const res = new MockResponse();
    res.onWrite = (chunk) => {
      if (chunk.includes("event: cursor")) req.emit("close");
    };

    await handler(req, res as unknown as ServerResponse);

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).toContain("event: cursor");
  });

  test("invalid SSE limits are rejected before stream headers and never request a data wipe", async () => {
    const { handler } = await fixture();
    const res = new MockResponse();

    await handler(
      request(`${CHANGES_PATH}?since=0%3A0&stream=1&limit=unbounded`, {
        accept: "text/event-stream",
      }),
      res as unknown as ServerResponse
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.json()).toStrictEqual({ error: "invalid_replica_limit" });
    expect(res.body).not.toContain("rebootstrap");
  });

  test("revoking the install behind an open tail ends it with a rebootstrap verdict", async () => {
    const { plane, handler } = await fixture();
    const since = watermark(plane);
    plane.revokeApp("agenda");
    const res = new MockResponse();

    await handler(
      request(`${CHANGES_PATH}?since=${since}&stream=1`, {
        accept: "text/event-stream",
      }),
      res as unknown as ServerResponse
    );

    expect(res.body).toContain("event: rebootstrap");
  });

  test("each door answers only its own method", async () => {
    const { handler } = await fixture();
    const changes = new MockResponse();
    await handler(
      request(CHANGES_PATH, { method: "POST" }),
      changes as unknown as ServerResponse
    );
    expect(changes.statusCode).toBe(405);
    expect(changes.headers.get("allow")).toBe("GET");

    const intents = new MockResponse();
    await handler(
      request("/centraid/_vault/replica/intents"),
      intents as unknown as ServerResponse
    );
    expect(intents.statusCode).toBe(405);
    expect(intents.headers.get("allow")).toBe("POST");
  });
});
