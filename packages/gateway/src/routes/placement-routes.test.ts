import crypto from "node:crypto";
import { promises as fs, mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, afterEach, expect, test, vi } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  blobUriFor,
  bootstrapVault,
  moveOutOfVault,
  openVaultDb,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import {
  makePlacementRouteHandler,
  PLACEMENTS_PATH,
} from "./placement-routes.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const vaults: VaultDb[] = [];
const dirs: string[] = [];

describe("placement-routes", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const vault of vaults.splice(0)) vault.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  test("resumes a move after target commit without duplicating or losing the item", async () => {
    const root = await tempDir("placement-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    const source = openBootstrappedVault(root, "personal", "vault-personal");
    const target = openBootstrappedVault(root, "family", "vault-family");
    const sourceItemId = seedContent(source.db, source.ownerPartyId, "move");
    const member = enrollments.enroll({
      endpointId: "member-phone",
      vaultId: "vault-personal",
      role: "admin",
      label: "Member phone",
      memberLabel: "Priya",
    });
    enrollments.members.setGrant(member.memberId, "vault-family", "write");

    let failSourceOnce = true;
    const move = vi.fn<typeof moveOutOfVault>((input) => {
      if (failSourceOnce) {
        failSourceOnce = false;
        throw new Error("simulated crash after target receipt");
      }
      return moveOutOfVault(input);
    });
    const handler = makePlacementRouteHandler({
      gatewayDatabase: database,
      enrollments,
      vaultFor: (vaultId) =>
        vaultId === "vault-personal"
          ? source.db
          : vaultId === "vault-family"
            ? target.db
            : undefined,
      move,
    });
    const server = http.createServer((req, res) => {
      void handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}${PLACEMENTS_PATH}`;
    const body = {
      linkToken: "move-link-1",
      kind: "move",
      itemType: "core.content_item",
      itemId: sourceItemId,
      sourceVaultId: "vault-personal",
      targetVaultId: "vault-family",
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
      linkToken: "move-link-1",
      status: "parked",
      targetState: "executed",
      sourceState: "queued",
    });
    expect(parkedBody.accessReceiptId).toStrictEqual(expect.any(String));
    expect(countContent(source.db)).toBe(1);
    expect(countContent(target.db)).toBe(1);

    const replayed = await post();
    expect(replayed.status).toBe(200);
    const replayedBody = (await replayed.json()) as Record<string, unknown>;
    expect(replayedBody).toMatchObject({
      status: "executed",
      targetState: "executed",
      sourceState: "executed",
    });
    expect(replayedBody.accessReceiptId).toBe(parkedBody.accessReceiptId);
    expect(
      database.db
        .prepare(
          "SELECT COUNT(*) AS n FROM share_access_receipts WHERE link_token = 'move-link-1'"
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
      placements: [
        expect.objectContaining({
          linkToken: "move-link-1",
          status: "executed",
        }),
      ],
    });
  });
});

function openBootstrappedVault(
  root: string,
  name: string,
  vaultId: string
): { db: VaultDb; ownerPartyId: string } {
  const dir = path.join(root, "vaults", name);
  mkdirSync(dir, { recursive: true });
  const db = openVaultDb({ dir });
  vaults.push(db);
  const boot = bootstrapVault(db, { ownerName: name, vaultId });
  return { db, ownerPartyId: boot.ownerPartyId };
}

function seedContent(db: VaultDb, ownerPartyId: string, label: string): string {
  const contentId = crypto.randomUUID();
  const blob = db.blobs.ingestSync(Buffer.from(`placement-${label}`));
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
      `Placement ${label}`,
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
