import crypto from "node:crypto";
import { promises as fs, mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, afterEach, expect, test, vi } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";
import {
  blobUriFor,
  bootstrapVault,
  moveOutOfVault,
  openVaultDb,
  signWithVaultIdentity,
  vaultIdentityPublicKey,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { BorrowedSlots } from "../serve/borrowed-slots.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { readLentEdge } from "../serve/lend-origin.js";
import { isLinkApproved } from "../serve/vault-link-row.js";
import { VaultLinksStore } from "../serve/vault-links-store.js";
import { EDGES_PATH, makeEdgesRouteHandler } from "./edges-routes.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

describe("edges-routes", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  test("resumes a same-owner move after target commit without duplicating or losing the item", async () => {
    const root = await tempDir("edges-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const links = new VaultLinksStore(database);
    const source = openBootstrappedVault(root, "personal", "vault-personal");
    const target = openBootstrappedVault(root, "family", "vault-family");
    const sourceItemId = seedContent(source.db, source.ownerPartyId, "move");
    // Ownership is the whole authority (#726): Priya owns both vaults.
    enrollments.enroll({
      endpointId: "member-phone",
      vaultIds: ["vault-personal", "vault-family"],
      label: "Member phone",
      ownerLabel: "Priya",
    });

    let failSourceOnce = true;
    const move = vi.fn<typeof moveOutOfVault>((input) => {
      if (failSourceOnce) {
        failSourceOnce = false;
        throw new Error("simulated crash after target receipt");
      }
      return moveOutOfVault(input);
    });
    const handler = makeEdgesRouteHandler({
      gatewayDatabase: database,
      enrollments,
      links,
      vaultFor: (vaultId) =>
        vaultId === "vault-personal"
          ? source.db
          : vaultId === "vault-family"
            ? target.db
            : undefined,
      move,
    });
    const url = await listen(handler);
    const body = {
      edgeId: "move-edge-1",
      kind: "move",
      mode: "snapshot",
      itemType: "core.content_item",
      itemIds: [sourceItemId],
      originVaultId: "vault-personal",
      audienceVaultId: "vault-family",
      verbs: "read",
    };
    const post = () =>
      fetch(url, {
        method: "POST",
        headers: {
          [AUTHED_DEVICE_HEADER]: "member-phone",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const parked = await post();
    expect(parked.status).toBe(202);
    const parkedBody = (await parked.json()) as Record<string, unknown>;
    expect(parkedBody).toMatchObject({
      edgeId: "move-edge-1",
      status: "parked",
      itemIds: [sourceItemId],
    });
    expect(parkedBody.accessReceiptId).toStrictEqual(expect.any(String));
    expect(countContent(source.db)).toBe(1);
    expect(countContent(target.db)).toBe(1);

    const replayed = await post();
    expect(replayed.status).toBe(200);
    const replayedBody = (await replayed.json()) as Record<string, unknown>;
    expect(replayedBody).toMatchObject({ status: "completed" });
    expect(replayedBody.accessReceiptId).toBe(parkedBody.accessReceiptId);
    expect(
      database.db
        .prepare(
          "SELECT COUNT(*) AS n FROM share_access_receipts WHERE edge_id = 'move-edge-1'"
        )
        .get()
    ).toMatchObject({ n: 1 });
    expect(countContent(source.db)).toBe(0);
    expect(countContent(target.db)).toBe(1);
    expect(move).toHaveBeenCalledTimes(2);

    const listed = await fetch(url, {
      headers: { [AUTHED_DEVICE_HEADER]: "member-phone" },
    });
    await expect(listed.json()).resolves.toMatchObject({
      edges: [
        expect.objectContaining({ edgeId: "move-edge-1", status: "completed" }),
      ],
    });

    // An unowned target is indistinguishable from a nonexistent one:
    // `not_found`, never `forbidden` (topology hiding, #726).
    const enrollments2 = EnrollmentStore.open(database);
    enrollments2.enroll({
      endpointId: "stranger-phone",
      vaultIds: ["vault-stranger"],
      label: "Stranger phone",
      ownerLabel: "Sid",
    });
    const refused = await fetch(url, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "stranger-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, edgeId: "move-edge-2" }),
    });
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toMatchObject({ error: "not_found" });
  });

  test("three items ride one edge: one row, one receipt, all three projected", async () => {
    const root = await tempDir("edges-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const links = new VaultLinksStore(database);
    const source = openBootstrappedVault(root, "personal", "vault-personal");
    const target = openBootstrappedVault(root, "family", "vault-family");
    const itemIds = [
      seedContent(source.db, source.ownerPartyId, "a"),
      seedContent(source.db, source.ownerPartyId, "b"),
      seedContent(source.db, source.ownerPartyId, "c"),
    ];
    enrollments.enroll({
      endpointId: "member-phone",
      vaultIds: ["vault-personal", "vault-family"],
      label: "Member phone",
      ownerLabel: "Priya",
    });
    const handler = makeEdgesRouteHandler({
      gatewayDatabase: database,
      enrollments,
      links,
      vaultFor: (vaultId) =>
        vaultId === "vault-personal"
          ? source.db
          : vaultId === "vault-family"
            ? target.db
            : undefined,
    });
    const url = await listen(handler);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "member-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        edgeId: "album-edge-1",
        kind: "add",
        mode: "snapshot",
        itemType: "core.content_item",
        itemIds,
        originVaultId: "vault-personal",
        audienceVaultId: "vault-family",
        verbs: "read",
      }),
    });
    expect(response.status).toBe(200);
    const wire = (await response.json()) as Record<string, unknown>;
    expect(wire.status).toBe("completed");
    expect(wire.itemIds).toStrictEqual(itemIds);
    expect(wire.targetItemIds).toHaveLength(3);

    expect(
      database.db.prepare("SELECT COUNT(*) AS n FROM share_edges").get()
    ).toMatchObject({ n: 1 });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS n FROM share_access_receipts")
        .get()
    ).toMatchObject({ n: 1 });
    const receipt = database.db
      .prepare("SELECT audience_item_ids_json FROM share_access_receipts")
      .get() as { audience_item_ids_json: string };
    expect(JSON.parse(receipt.audience_item_ids_json)).toHaveLength(3);
    expect(countContent(target.db)).toBe(3);
  });

  test("mode: 'live' opens a real window at the route, and refuses typed without a signer", async () => {
    const root = await tempDir("edges-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const links = new VaultLinksStore(database);
    const source = openBootstrappedVault(root, "personal", "vault-personal");
    const target = openBootstrappedVault(root, "family", "vault-family");
    seedContent(source.db, source.ownerPartyId, "live");
    enrollments.enroll({
      endpointId: "member-phone",
      vaultIds: ["vault-personal", "vault-family"],
      label: "Member phone",
      ownerLabel: "Priya",
    });
    const vaultFor = (vaultId: string) =>
      vaultId === "vault-personal"
        ? source.db
        : vaultId === "vault-family"
          ? target.db
          : undefined;
    const body = {
      edgeId: "live-edge-1",
      kind: "add",
      mode: "live",
      itemType: "core.content_item",
      scopes: [{ schema: "core", table: "content_item" }],
      originVaultId: "vault-personal",
      audienceVaultId: "vault-family",
      verbs: "read",
    };

    // A build with no vault signer cannot lend at all — the lease IS the
    // audience's authority, so this refuses as a CAPABILITY rather than
    // opening an unsigned window.
    const unsigned = await listen(
      makeEdgesRouteHandler({
        gatewayDatabase: database,
        enrollments,
        links,
        vaultFor,
      })
    );
    const refused = await fetch(unsigned, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "member-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: "lending_unavailable",
    });
    expect(
      database.db.prepare("SELECT COUNT(*) AS n FROM share_edges").get()
    ).toMatchObject({ n: 0 });

    // Wired properly, the same request opens a live edge: it reaches
    // `established` (not `completed` — nothing finished) and mints an
    // ordinary consent grant whose grantee is the AUDIENCE VAULT's party.
    const borrowed = new BorrowedSlots(database, path.join(root, "data"));
    const url = await listen(
      makeEdgesRouteHandler({
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
      })
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "member-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "live",
      status: "established",
      scopes: [{ schema: "core", table: "content_item" }],
    });
    const lent = readLentEdge(database, "live-edge-1")!;
    expect(lent.revoked_at).toBeNull();
    expect(
      source.db.vault
        .prepare(
          `SELECT count(*) AS n FROM consent_access_grant
            WHERE grantee_party_id = ? AND app_id IS NULL AND status = 'active'`
        )
        .get(lent.grantee_party_id)
    ).toMatchObject({ n: 1 });
    borrowed.close();
  });

  test("self-share guard: origin and audience must differ", async () => {
    const root = await tempDir("edges-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const links = new VaultLinksStore(database);
    const source = openBootstrappedVault(root, "personal", "vault-personal");
    const itemId = seedContent(source.db, source.ownerPartyId, "self");
    enrollments.enroll({
      endpointId: "member-phone",
      vaultIds: ["vault-personal"],
      label: "Member phone",
      ownerLabel: "Priya",
    });
    const handler = makeEdgesRouteHandler({
      gatewayDatabase: database,
      enrollments,
      links,
      vaultFor: (vaultId) =>
        vaultId === "vault-personal" ? source.db : undefined,
    });
    const url = await listen(handler);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "member-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        edgeId: "self-edge-1",
        kind: "add",
        mode: "snapshot",
        itemType: "core.content_item",
        itemIds: [itemId],
        originVaultId: "vault-personal",
        audienceVaultId: "vault-personal",
        verbs: "read",
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_edge",
    });
  });

  test("cross-owner: same substrate as same-owner, gated only by an approved link", async () => {
    const root = await tempDir("edges-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const links = new VaultLinksStore(database);
    const father = openBootstrappedVault(root, "father", "vault-father");
    const daughter = openBootstrappedVault(root, "daughter", "vault-daughter");
    const itemId = seedContent(father.db, father.ownerPartyId, "photo");
    enrollments.enroll({
      endpointId: "father-phone",
      vaultIds: ["vault-father"],
      label: "Father phone",
      ownerLabel: "Father",
    });
    enrollments.enroll({
      endpointId: "daughter-phone",
      vaultIds: ["vault-daughter"],
      label: "Daughter phone",
      ownerLabel: "Daughter",
    });
    const handler = makeEdgesRouteHandler({
      gatewayDatabase: database,
      enrollments,
      links,
      vaultFor: (vaultId) =>
        vaultId === "vault-father"
          ? father.db
          : vaultId === "vault-daughter"
            ? daughter.db
            : undefined,
    });
    const url = await listen(handler);
    const edgeBody = {
      edgeId: "cross-owner-edge-1",
      kind: "add",
      mode: "snapshot",
      itemType: "core.content_item",
      itemIds: [itemId],
      originVaultId: "vault-father",
      audienceVaultId: "vault-daughter",
      verbs: "read",
    };
    const postAsFather = () =>
      fetch(url, {
        method: "POST",
        headers: {
          [AUTHED_DEVICE_HEADER]: "father-phone",
          "content-type": "application/json",
        },
        body: JSON.stringify(edgeBody),
      });

    // No link yet: topology hiding, `not_found` — indistinguishable from
    // the vault not existing at all.
    const refused = await postAsFather();
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toMatchObject({ error: "not_found" });

    // Father proposes the link — his own side is implicitly approved.
    const proposed = links.propose({
      fromVaultId: "vault-father",
      fromPublicKey: "key-father",
      toVaultId: "vault-daughter",
      toPublicKey: "key-daughter",
    });
    expect(proposed.approvedByA !== null || proposed.approvedByB !== null).toBe(
      true
    );
    expect(isLinkApproved(proposed)).toBe(false);

    // Still refused — one approval is not enough.
    const stillRefused = await postAsFather();
    expect(stillRefused.status).toBe(404);

    // Daughter's device approves her own side.
    links.approve(proposed.linkId, "vault-daughter");
    expect(isLinkApproved(links.get(proposed.linkId)!)).toBe(true);

    // Now it rides the SAME substrate a same-owner edge would.
    const succeeded = await postAsFather();
    expect(succeeded.status).toBe(200);
    await expect(succeeded.json()).resolves.toMatchObject({
      status: "completed",
    });
    expect(countContent(daughter.db)).toBe(1);

    // A cross-owner MOVE is refused even with an approved link — giving
    // away and erasing your own copy only coheres within one owner's vaults.
    const moveRefused = await fetch(url, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: "father-phone",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...edgeBody,
        edgeId: "cross-owner-move-1",
        kind: "move",
      }),
    });
    expect(moveRefused.status).toBe(400);
    await expect(moveRefused.json()).resolves.toMatchObject({
      error: "cross_owner_move_refused",
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
  return `http://127.0.0.1:${port}${EDGES_PATH}`;
}

function openBootstrappedVault(
  root: string,
  name: string,
  vaultId: string
): { db: VaultDb; ownerPartyId: string } {
  const dir = path.join(root, "vaults", name);
  mkdirSync(dir, { recursive: true });
  const { db, boot } = bootstrappedVault(
    { openVaultDb, bootstrapVault },
    { dir, ownerName: name, vaultId }
  );
  return { db, ownerPartyId: boot.ownerPartyId };
}

function seedContent(db: VaultDb, ownerPartyId: string, label: string): string {
  const contentId = crypto.randomUUID();
  const blob = db.blobs.ingestSync(Buffer.from(`edge-${label}-${contentId}`));
  db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title,
          creator_party_id, created_at)
       VALUES (?, 'image/jpeg', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      contentId,
      blobUriFor(blob.sha256),
      blob.sha256,
      blob.byteSize,
      `Edge ${label}`,
      ownerPartyId,
      new Date().toISOString()
    );
  return contentId;
}

function countContent(db: VaultDb): number {
  return (
    db.vault.prepare("SELECT count(*) AS n FROM core_content_item").get() as {
      n: number;
    }
  ).n;
}
