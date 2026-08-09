/*
 * The deferred P4 device route, built (#726 P5): a phone bootstraps a
 * borrowed shape read-only and picks up origin changes, and can never reach
 * a borrowed shape belonging to a vault its own owner does not own.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, afterEach, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { BorrowedStore } from "../serve/borrowed-store.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import {
  BORROWED_BOOTSTRAP_PATH,
  BORROWED_CHANGES_PATH,
  BORROWED_INTENTS_PATH,
  makeBorrowedReplicaRouteHandler,
} from "./borrowed-replica-routes.js";
import { expectedPayloadHash } from "./replica-intent-shape.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const stores: BorrowedStore[] = [];
const dirs: string[] = [];

describe("borrowed-replica-routes (#726 P5 device route)", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const database of databases.splice(0)) database.close();
    for (const store of stores.splice(0)) store.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function harness(
    input: {
      verbs?: "read" | "read+act";
      state?: "offered" | "established" | "parked" | "dropped";
    } = {}
  ) {
    const root = await tempDir("borrowed-replica-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    // Priya owns the AUDIENCE vault the edge was lent TO.
    enrollments.enroll({
      endpointId: "priya-phone",
      vaultIds: ["vault-priya"],
      label: "Priya's phone",
      ownerLabel: "Priya",
    });
    // Sid owns a DIFFERENT vault — never the owner of this edge.
    enrollments.enroll({
      endpointId: "sid-phone",
      vaultIds: ["vault-sid"],
      label: "Sid's phone",
      ownerLabel: "Sid",
    });
    const now = new Date().toISOString();
    database.run(
      `INSERT INTO borrowed_edges
         (edge_id, link_id, origin_vault_id, audience_vault_id, item_type,
          holder_label, origin_public_key, verbs, state, reason, created_at, updated_at)
       VALUES (?, 'link-1', 'vault-ada', 'vault-priya', 'core.collection',
               'Ada', 'pk', ?, ?, NULL, ?, ?)`,
      "edge-1",
      input.verbs ?? "read",
      input.state ?? "established",
      now,
      now
    );
    const store = BorrowedStore.open(
      path.join(root, "borrowed", "vault-ada.db")
    );
    stores.push(store);
    const handler = makeBorrowedReplicaRouteHandler({
      gatewayDatabase: database,
      enrollments,
      storeFor: (peerVaultId) =>
        peerVaultId === "vault-ada" ? store : BorrowedStore.open(":memory:"),
    });
    const url = await listen(handler);
    const get = (requestPath: string, endpointId?: string) =>
      fetch(`${url}${requestPath}`, {
        headers: endpointId ? { [AUTHED_DEVICE_HEADER]: endpointId } : {},
      });
    const post = (requestPath: string, body: unknown, endpointId?: string) =>
      fetch(`${url}${requestPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpointId ? { [AUTHED_DEVICE_HEADER]: endpointId } : {}),
        },
        body: JSON.stringify(body),
      });
    return { store, get, post };
  }

  function landShape(store: BorrowedStore): void {
    store.beginBootstrap({
      shapeId: "shape-1",
      edgeId: "edge-1",
      originVaultId: "vault-ada",
      appId: "lent:party-1",
      purpose: "dpv:ServiceProvision",
      schemaEpoch: "1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      entities: [
        {
          entity: "core.collection",
          primaryKey: "collection_id",
          columns: ["collection_id", "name"],
        },
      ],
    });
    store.applyPage([
      {
        shapeId: "shape-1",
        entity: "core.collection",
        rowId: "col-1",
        values: { collection_id: "col-1", name: "Groceries" },
      },
    ]);
    store.commitBootstrap("shape-1", { epoch: "e1", seq: 1 });
  }

  test("a phone receives the ordinary edge-scoped replica bootstrap envelope", async () => {
    const { store, get } = await harness();
    landShape(store);
    const res = await get(
      `${BORROWED_BOOTSTRAP_PATH}?edgeId=edge-1`,
      "priya-phone"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      vaultId: string;
      shapes: Array<{ shapeId: string; entities: Array<{ entity: string }> }>;
      rows: Array<{
        entity: string;
        rowId: string;
        values: Record<string, unknown>;
      }>;
      cursor: { epoch: string; seq: number };
      complete: boolean;
    };
    expect(body.vaultId).toBe("borrowed:edge-1");
    expect(body.shapes[0]?.entities).toMatchObject([
      { entity: "core.collection" },
    ]);
    expect(body.rows).toMatchObject([
      {
        entity: "core.collection",
        rowId: "col-1",
        values: { name: "Groceries" },
      },
    ]);
    expect(body.complete).toBe(true);
  });

  test("a read+act device intent is durably queued for the origin", async () => {
    const { store, get, post } = await harness({ verbs: "read+act" });
    landShape(store);
    const bootstrap = await get(
      `${BORROWED_BOOTSTRAP_PATH}?edgeId=edge-1`,
      "priya-phone"
    );
    const initial = (await bootstrap.json()) as {
      cursor: { seq: number };
    };
    const body = { itemId: "col-1", name: "Hardware" };
    const res = await post(
      `${BORROWED_INTENTS_PATH}?edgeId=edge-1`,
      {
        intentId: "intent-1",
        appId: "tasks",
        action: "rename",
        input: body,
        payloadHash: expectedPayloadHash("tasks", "rename", body, []),
      },
      "priya-phone"
    );
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      outcome: { intentId: "intent-1", status: "in-flight" },
    });
    expect(store.intent("intent-1")).toMatchObject({
      edgeId: "edge-1",
      action: "rename",
      payloadHash: expectedPayloadHash("edge-1", "rename", body, []),
      status: "queued",
    });

    store.recordIntentOutcome("intent-1", {
      status: "parked",
      reason: "waiting for owner confirmation",
    });
    const parked = await get(
      `${BORROWED_CHANGES_PATH}?edgeId=edge-1&since=${initial.cursor.seq}`,
      "priya-phone"
    );
    const parkedBody = (await parked.json()) as {
      to: { seq: number };
      outcomes: unknown[];
    };
    expect(parkedBody.to.seq).toBeGreaterThan(initial.cursor.seq);
    expect(parkedBody.outcomes).toMatchObject([
      {
        intentId: "intent-1",
        status: "parked",
        reason: "waiting for owner confirmation",
      },
    ]);

    store.recordIntentOutcome("intent-1", { status: "executed" });
    const executed = await get(
      `${BORROWED_CHANGES_PATH}?edgeId=edge-1&since=${parkedBody.to.seq}`,
      "priya-phone"
    );
    const executedBody = (await executed.json()) as {
      to: { seq: number };
      outcomes: unknown[];
    };
    expect(executedBody).toMatchObject({
      outcomes: [{ intentId: "intent-1", status: "executed" }],
    });

    const conflictInput = { itemId: "col-1", name: "Garden" };
    const baseVersions = [
      { entity: "core.collection", rowId: "col-1", version: 1 },
    ];
    const conflictQueued = await post(
      `${BORROWED_INTENTS_PATH}?edgeId=edge-1`,
      {
        intentId: "intent-conflict",
        appId: "tasks",
        action: "rename",
        input: conflictInput,
        baseVersions,
        payloadHash: expectedPayloadHash(
          "tasks",
          "rename",
          conflictInput,
          baseVersions
        ),
      },
      "priya-phone"
    );
    expect(conflictQueued.status).toBe(202);
    store.recordIntentOutcome("intent-conflict", {
      status: "conflict",
      conflict: {
        entity: "core.collection",
        rowId: "col-1",
        expectedVersion: 1,
        actualVersion: 2,
      },
    });
    const conflicted = await get(
      `${BORROWED_CHANGES_PATH}?edgeId=edge-1&since=${executedBody.to.seq}`,
      "priya-phone"
    );
    await expect(conflicted.json()).resolves.toMatchObject({
      outcomes: expect.arrayContaining([
        {
          intentId: "intent-conflict",
          status: "conflict",
          conflict: {
            entity: "core.collection",
            rowId: "col-1",
            expectedVersion: 1,
            actualVersion: 2,
          },
        },
      ]),
    });
  });

  test("an edge that has not landed a shape yet answers a STATE, not an error", async () => {
    const { get } = await harness();
    const res = await get(
      `${BORROWED_BOOTSTRAP_PATH}?edgeId=edge-1`,
      "priya-phone"
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "borrowed_replica_not_yet_available",
      retryable: true,
    });
  });

  test("picks up origin changes past a cursor", async () => {
    const { store, get } = await harness();
    landShape(store);
    const first = await get(
      `${BORROWED_BOOTSTRAP_PATH}?edgeId=edge-1`,
      "priya-phone"
    );
    const { cursor } = (await first.json()) as {
      cursor: { epoch: string; seq: number };
    };

    store.applyChanges(
      "shape-1",
      [
        {
          op: "upsert",
          shapeId: "shape-1",
          entity: "core.collection",
          rowId: "col-2",
          values: { collection_id: "col-2", name: "Hardware" },
        },
      ],
      { epoch: "e1", seq: 2 }
    );

    const changes = await get(
      `${BORROWED_CHANGES_PATH}?edgeId=edge-1&since=${cursor.seq}`,
      "priya-phone"
    );
    expect(changes.status).toBe(200);
    const body = (await changes.json()) as {
      from: { seq: number };
      to: { seq: number };
      changes: Array<{
        op: string;
        entity: string;
        rowId: string;
        values: Record<string, unknown>;
      }>;
    };
    expect(body.from.seq).toBe(cursor.seq);
    expect(body.to.seq).toBeGreaterThan(cursor.seq);
    expect(body.changes).toMatchObject([
      {
        op: "upsert",
        entity: "core.collection",
        rowId: "col-2",
        values: { name: "Hardware" },
      },
    ]);
  });

  test("a device can never reach a borrowed shape belonging to a vault its owner does not own", async () => {
    const { store, get } = await harness();
    landShape(store);
    const res = await get(
      `${BORROWED_BOOTSTRAP_PATH}?edgeId=edge-1`,
      "sid-phone"
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" });
  });

  test("a dropped edge is not_found, same as one that never existed", async () => {
    const { store, get } = await harness({ state: "dropped" });
    landShape(store);
    const res = await get(
      `${BORROWED_BOOTSTRAP_PATH}?edgeId=edge-1`,
      "priya-phone"
    );
    expect(res.status).toBe(404);
    const unknown = await get(
      `${BORROWED_BOOTSTRAP_PATH}?edgeId=edge-nope`,
      "priya-phone"
    );
    expect(unknown.status).toBe(404);
  });

  test("no device identity refuses distinctly from an unowned edge", async () => {
    const { get } = await harness();
    const res = await get(`${BORROWED_BOOTSTRAP_PATH}?edgeId=edge-1`);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "device_identity_required",
    });
  });
});

async function listen(handler: RouteHandler): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
