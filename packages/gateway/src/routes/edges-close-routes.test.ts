/*
 * Exit evidence for #726 P6 gap 1 — the owner-facing revoke route.
 * `closeLiveEdge` and `dropBorrowedEdge` were already tested directly
 * (`lend-live-edge.test.ts`); this file proves the HTTP door that reaches
 * them: authorization, disambiguation between origin/audience, topology
 * hiding, and durable delivery to an unreachable peer.
 */

import { promises as fs, mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, afterEach, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";
import {
  bootstrapVault,
  openVaultDb,
  signWithVaultIdentity,
  vaultIdentityPublicKey,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { BorrowedSlots } from "../serve/borrowed-slots.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { syncBorrowedEdge } from "../serve/lend-audience.js";
import { drainPendingLendCloses } from "../serve/lend-close-relay.js";
import {
  borrowedSlotsFor,
  lend,
  seedList,
} from "../serve/lend.test-fixtures.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import { dialFrom, link, makeSide } from "../serve/peer-give.test-fixtures.js";
import type { Side } from "../serve/peer-give.test-fixtures.js";
import { VaultLinksStore } from "../serve/vault-links-store.js";
import { makeEdgeCloseRouteHandler } from "./edges-close-routes.js";
import type { EdgeCloseRouteDeps } from "./edges-close-routes.js";
import { EDGES_PATH, makeEdgesRouteHandler } from "./edges-routes.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];
const LIST_SCOPES = [
  { schema: "core", table: "collection" },
  { schema: "core", table: "collection_entry" },
];

describe("edges-close-routes", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function listen(deps: EdgeCloseRouteDeps): Promise<string> {
    const handler = makeEdgeCloseRouteHandler(deps);
    const server = http.createServer((req, res) => {
      void handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}${EDGES_PATH}`;
  }

  function receiptsFor(side: Side, edgeId: string): Array<{ action: string }> {
    return side.gatewayDb.db
      .prepare("SELECT action FROM share_access_receipts WHERE edge_id = ?")
      .all(edgeId) as Array<{ action: string }>;
  }

  async function establishedLend(edgeId: string) {
    const origin = makeSide(`origin-${crypto.randomUUID().slice(0, 8)}`);
    const audience = makeSide(`audience-${crypto.randomUUID().slice(0, 8)}`);
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    seedList(origin, "Groceries", 2);
    const opened = await lend(origin, audience, borrowed, {
      edgeId,
      itemType: "core.collection",
      scopes: LIST_SCOPES,
    });
    await syncBorrowedEdge(borrowed, opened.identity, opened.pull);
    return { origin, audience, borrowed };
  }

  test("the origin owner stops lending: the audience's shape clears, receipted, over the SAME converged path", async () => {
    const { origin, audience, borrowed } = await establishedLend("edge-stop-1");
    const store = borrowed.storeFor(origin.vaultId);
    expect(store.shapeForEdge("edge-stop-1")).toBeDefined();

    const base = await listen({
      gatewayDatabase: origin.gatewayDb,
      enrollments: EnrollmentStore.open(origin.gatewayDb),
      links: origin.links,
      vaultFor: (vaultId) =>
        vaultId === origin.vaultId ? origin.vault : undefined,
      peerDial: dialFrom(origin, audience, borrowed),
    });
    const response = await fetch(`${base}/edge-stop-1`, {
      method: "DELETE",
      headers: { [AUTHED_DEVICE_HEADER]: origin.deviceId },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      edgeId: "edge-stop-1",
      status: "revoked",
    });
    expect(store.shapeForEdge("edge-stop-1")).toBeUndefined();
    // `receiptsFor` returns rows straight off the SQLite driver, on its own
    // prototype — `toStrictEqual` would fail on that provenance, not on the
    // data, so this stays `toEqual`.
    // oxlint-disable-next-line vitest/prefer-strict-equal -- see comment above
    expect(receiptsFor(audience, "edge-stop-1")).toEqual([
      { action: "unshare" },
    ]);
  });

  test("stopping a lend while the peer is unreachable still succeeds locally and delivers on next contact", async () => {
    const { origin, audience, borrowed } = await establishedLend("edge-stop-2");
    const store = borrowed.storeFor(origin.vaultId);
    expect(store.shapeForEdge("edge-stop-2")).toBeDefined();

    const unreachable: PeerDial = {
      request: () => Promise.reject(new Error("simulated network failure")),
      endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
    };
    const base = await listen({
      gatewayDatabase: origin.gatewayDb,
      enrollments: EnrollmentStore.open(origin.gatewayDb),
      links: origin.links,
      vaultFor: (vaultId) =>
        vaultId === origin.vaultId ? origin.vault : undefined,
      peerDial: unreachable,
    });
    const response = await fetch(`${base}/edge-stop-2`, {
      method: "DELETE",
      headers: { [AUTHED_DEVICE_HEADER]: origin.deviceId },
    });
    // Local effect is unconditional: revoked at the origin regardless of
    // whether the audience could be reached this instant.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "revoked" });
    expect(
      origin.gatewayDb.db
        .prepare("SELECT 1 FROM peer_pending_lend_closes WHERE edge_id = ?")
        .get("edge-stop-2")
    ).toBeDefined();
    // The audience has heard nothing yet — nothing here touched the network.
    expect(store.shapeForEdge("edge-stop-2")).toBeDefined();

    // Delivery on next contact: a reachable dial drains the pending row and
    // the audience's shape clears — no second ceremony, no owner action.
    const drained = await drainPendingLendCloses({
      db: origin.gatewayDb,
      links: origin.links,
      dial: dialFrom(origin, audience, borrowed),
    });
    expect(drained.acknowledged).toStrictEqual(["edge-stop-2"]);
    expect(store.shapeForEdge("edge-stop-2")).toBeUndefined();
    expect(
      origin.gatewayDb.db
        .prepare("SELECT 1 FROM peer_pending_lend_closes WHERE edge_id = ?")
        .get("edge-stop-2")
    ).toBeUndefined();
  });

  test("an audience owner drops a borrowed edge and the same shape clears, no peer contact needed", async () => {
    const { origin, audience, borrowed } = await establishedLend("edge-drop-1");
    const store = borrowed.storeFor(origin.vaultId);
    expect(store.shapeForEdge("edge-drop-1")).toBeDefined();

    const base = await listen({
      gatewayDatabase: audience.gatewayDb,
      enrollments: EnrollmentStore.open(audience.gatewayDb),
      links: audience.links,
      vaultFor: (vaultId) =>
        vaultId === audience.vaultId ? audience.vault : undefined,
      borrowed,
    });
    const response = await fetch(`${base}/edge-drop-1`, {
      method: "DELETE",
      headers: { [AUTHED_DEVICE_HEADER]: audience.deviceId },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      edgeId: "edge-drop-1",
      state: "dropped",
    });
    expect(store.shapeForEdge("edge-drop-1")).toBeUndefined();
    // See the comment on the earlier `receiptsFor` assertion: SQLite driver
    // rows, own prototype, `toEqual` not `toStrictEqual`.
    // oxlint-disable-next-line vitest/prefer-strict-equal -- see comment above
    expect(receiptsFor(audience, "edge-drop-1")).toEqual([
      { action: "unshare" },
    ]);
  });

  test("an owner with no side of the edge gets not_found — topology hiding", async () => {
    const { origin } = await establishedLend("edge-hidden");
    // A second, unrelated owner on the ORIGIN's own gateway.db — enrolled,
    // so it passes the identity check, but owns neither side of this edge.
    EnrollmentStore.open(origin.gatewayDb).enroll({
      endpointId: "stranger-device",
      vaultIds: ["vault-stranger"],
      label: "Stranger device",
      ownerLabel: "Stranger",
    });
    const base = await listen({
      gatewayDatabase: origin.gatewayDb,
      enrollments: EnrollmentStore.open(origin.gatewayDb),
      links: origin.links,
      vaultFor: (vaultId) =>
        vaultId === origin.vaultId ? origin.vault : undefined,
    });
    const response = await fetch(`${base}/edge-hidden`, {
      method: "DELETE",
      headers: { [AUTHED_DEVICE_HEADER]: "stranger-device" },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  test("an unknown edge id gets not_found too — indistinguishable from one this owner has no side of", async () => {
    const { origin } = await establishedLend("edge-real");
    const base = await listen({
      gatewayDatabase: origin.gatewayDb,
      enrollments: EnrollmentStore.open(origin.gatewayDb),
      links: origin.links,
      vaultFor: (vaultId) =>
        vaultId === origin.vaultId ? origin.vault : undefined,
    });
    const response = await fetch(`${base}/edge-does-not-exist`, {
      method: "DELETE",
      headers: { [AUTHED_DEVICE_HEADER]: origin.deviceId },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  test("closing a snapshot edge is refused typed, not silently accepted", async () => {
    const origin = makeSide(`origin-snap-${crypto.randomUUID().slice(0, 8)}`);
    const audience = makeSide(
      `audience-snap-${crypto.randomUUID().slice(0, 8)}`
    );
    await link(origin, audience);
    // A plain snapshot row — no live-edge ceremony needed for this check.
    origin.gatewayDb.run(
      `INSERT INTO share_edges
         (edge_id, created_by_device, owner_id, kind, mode, item_type,
          scope_json, origin_vault_id, audience_vault_id, verbs,
          target_state, source_state, status, created_at, updated_at)
       VALUES ('edge-snap', ?, ?, 'add', 'snapshot', 'core.collection', '[]', ?, ?, 'read',
               'queued', 'not-needed', 'completed', ?, ?)`,
      origin.deviceId,
      origin.ownerId,
      origin.vaultId,
      audience.vaultId,
      new Date().toISOString(),
      new Date().toISOString()
    );
    const base = await listen({
      gatewayDatabase: origin.gatewayDb,
      enrollments: EnrollmentStore.open(origin.gatewayDb),
      links: origin.links,
      vaultFor: (vaultId) =>
        vaultId === origin.vaultId ? origin.vault : undefined,
    });
    const response = await fetch(`${base}/edge-snap`, {
      method: "DELETE",
      headers: { [AUTHED_DEVICE_HEADER]: origin.deviceId },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_a_live_edge",
    });
  });

  test("a co-hosted lend closes with no wire: the local borrowed shape drops directly through the same door", async () => {
    const root = await tempDir("edges-close-cohosted-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const links = new VaultLinksStore(database);

    const sourceDir = path.join(root, "vaults", "personal");
    mkdirSync(sourceDir, { recursive: true });
    const source = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { dir: sourceDir, ownerName: "personal", vaultId: "vault-personal" }
    );
    const targetDir = path.join(root, "vaults", "family");
    mkdirSync(targetDir, { recursive: true });
    const target = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { dir: targetDir, ownerName: "family", vaultId: "vault-family" }
    );
    enrollments.enroll({
      endpointId: "member-phone",
      vaultIds: ["vault-personal", "vault-family"],
      label: "Member phone",
      ownerLabel: "Priya",
    });
    const vaultFor = (vaultId: string): VaultDb | undefined =>
      vaultId === "vault-personal"
        ? source.db
        : vaultId === "vault-family"
          ? target.db
          : undefined;
    const borrowed = new BorrowedSlots(database, path.join(root, "data"));

    const openHandler = makeEdgesRouteHandler({
      gatewayDatabase: database,
      enrollments,
      links,
      vaultFor,
      signAsVault: (vaultId, bytes) =>
        vaultId === "vault-personal"
          ? signWithVaultIdentity(source.db.identitySeed, bytes)
          : undefined,
      borrowed,
      vaultPublicKey: (vaultId) =>
        vaultId === "vault-personal"
          ? vaultIdentityPublicKey(source.db.identitySeed).toString("base64")
          : undefined,
    });
    const openServer = http.createServer(
      (req, res) => void openHandler(req, res)
    );
    servers.push(openServer);
    await new Promise<void>((resolve) => {
      openServer.listen(0, "127.0.0.1", resolve);
    });
    const openPort = (openServer.address() as AddressInfo).port;
    const opened = await fetch(`http://127.0.0.1:${openPort}${EDGES_PATH}`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "member-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        edgeId: "edge-cohosted",
        kind: "add",
        mode: "live",
        itemType: "core.content_item",
        scopes: [{ schema: "core", table: "content_item" }],
        originVaultId: "vault-personal",
        audienceVaultId: "vault-family",
        verbs: "read",
      }),
    });
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toMatchObject({
      status: "established",
    });
    const store = borrowed.storeFor("vault-personal");
    expect(store.shapeForEdge("edge-cohosted")).toBeDefined();

    const base = await listen({
      gatewayDatabase: database,
      enrollments,
      links,
      vaultFor,
      borrowed,
    });
    const closed = await fetch(`${base}/edge-cohosted`, {
      method: "DELETE",
      headers: { [AUTHED_DEVICE_HEADER]: "member-phone" },
    });
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({ status: "revoked" });
    expect(store.shapeForEdge("edge-cohosted")).toBeUndefined();
    borrowed.close();
  });
});
