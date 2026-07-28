import crypto from "node:crypto";
/*
 * The cross-vault share plane (issue #599 decision 11).
 *
 * Two REAL vaults on real disk under one gateway root — the deployed topology
 * — because the claims are filesystem and authorization facts at once: the
 * audience can read what was placed there, the origin is never written, and
 * who may place is decided by `member_roles`, not by hardware.
 */
import { promises as fs, mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { plainSqliteRow } from "@centraid/test-kit/sqlite";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  bootstrapVault,
  blobUriFor,
  openVaultDb,
  type VaultDb,
} from "@centraid/vault";
import { describe, afterEach, expect, test } from "vitest";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { makeShareRouteHandler } from "./share-routes.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const vaults: VaultDb[] = [];
const dirs: string[] = [];
describe("share-routes suite", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const vault of vaults.splice(0)) vault.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  interface Harness {
    url: string;
    enrollments: EnrollmentStore;
    priyaVault: VaultDb;
    familyVault: VaultDb;
    /** Priya: admin of her own vault, `write` in Family. */
    priya: string;
    /** Sid: `read` in Family only — he may look, never place. */
    sid: string;
    contentId: string;
    bytes: Buffer;
  }

  /** A blob-backed content item, as any ingest path would leave one. */
  function seedItem(
    db: VaultDb,
    ownerPartyId: string,
    deviceId: string,
    label: string
  ): string {
    const bytes = Buffer.from(`bytes-${label}`);
    const blob = db.blobs.ingestSync(bytes);
    const contentId = crypto.randomUUID();
    db.vault
      .prepare(
        `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'image/jpeg', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`
      )
      .run(
        contentId,
        blobUriFor(blob.sha256),
        blob.sha256,
        blob.byteSize,
        `Item ${label}`,
        ownerPartyId,
        deviceId,
        new Date().toISOString()
      );
    return contentId;
  }

  async function harness(): Promise<Harness> {
    const root = await tempDir("share-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);

    const priyaDir = path.join(root, "vaults", "priya");
    const familyDir = path.join(root, "vaults", "family");
    mkdirSync(priyaDir, { recursive: true });
    mkdirSync(familyDir, { recursive: true });
    const priyaVault = openVaultDb({ dir: priyaDir });
    const familyVault = openVaultDb({ dir: familyDir });
    vaults.push(priyaVault, familyVault);
    const priyaBoot = bootstrapVault(priyaVault, {
      ownerName: "Priya",
      vaultId: "vault-priya",
    });
    bootstrapVault(familyVault, {
      ownerName: "Family",
      vaultId: "vault-family",
    });
    const contentId = seedItem(
      priyaVault,
      priyaBoot.ownerPartyId,
      priyaBoot.deviceId,
      "a"
    );

    const priya = enrollments.enroll({
      endpointId: "priya-laptop",
      vaultId: "vault-priya",
      role: "admin",
      label: "Priya laptop",
      memberLabel: "Priya",
    });
    enrollments.members.setGrant(priya.memberId, "vault-family", "write");
    const sid = enrollments.enroll({
      endpointId: "sid-phone",
      vaultId: "vault-family",
      role: "read",
      label: "Sid phone",
      memberLabel: "Sid",
    });

    const handler = makeShareRouteHandler({
      enrollments,
      vaultFor: (vaultId) =>
        vaultId === "vault-priya"
          ? priyaVault
          : vaultId === "vault-family"
            ? familyVault
            : undefined,
      isHostCustody: (req) => req.headers["x-test-host-custody"] === "1",
    });
    const server = http.createServer((req, res) => {
      void (async () => {
        if (!(await handler(req, res))) {
          res.statusCode = 404;
          res.end("{}");
        }
      })();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/centraid/_gateway/share`,
      enrollments,
      priyaVault,
      familyVault,
      priya: priya.memberId,
      sid: sid.memberId,
      contentId,
      bytes: Buffer.from("bytes-a"),
    };
  }

  function headers(
    endpointId?: string,
    hostCustody = false
  ): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(endpointId ? { [AUTHED_DEVICE_HEADER]: endpointId } : {}),
      ...(hostCustody ? { "x-test-host-custody": "1" } : {}),
    };
  }

  function shareBody(contentId: string): string {
    return JSON.stringify({
      originVaultId: "vault-priya",
      audienceVaultId: "vault-family",
      itemType: "core.content_item",
      itemId: contentId,
    });
  }

  function countIn(db: VaultDb, table: string): number {
    return (
      db.vault.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;
  }

  // ---------------------------------------------------------------------------
  // The share itself
  // ---------------------------------------------------------------------------

  test("a write-in-audience member places the item, and the origin is untouched", async () => {
    const f = await harness();

    const response = await fetch(f.url, {
      method: "POST",
      headers: headers("priya-laptop"),
      body: shareBody(f.contentId),
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      itemId: string;
      deduped: boolean;
    };
    expect(result.deduped).toBe(false);

    // The audience can READ it: row and bytes both landed.
    const placed = f.familyVault.vault
      .prepare(
        "SELECT sha256, title FROM core_content_item WHERE content_id = ?"
      )
      .get(result.itemId) as { sha256: string; title: string };
    expect(placed.title).toBe("Item a");
    expect(f.familyVault.blobs.getSync(placed.sha256)).toStrictEqual(f.bytes);
    // Provenance names the acting MEMBER, not the device.
    expect(
      plainSqliteRow(
        f.familyVault.vault
          .prepare(
            "SELECT origin_vault_id, shared_by_member FROM core_share_origin"
          )
          .get()
      )
    ).toStrictEqual({
      origin_vault_id: "vault-priya",
      shared_by_member: f.priya,
    });
    // The origin was read-only throughout.
    expect(countIn(f.priyaVault, "core_content_item")).toBe(1);
    expect(countIn(f.priyaVault, "core_share_origin")).toBe(0);
  });

  test("re-sharing the same item dedupes onto the placed row", async () => {
    const f = await harness();
    const post = () =>
      fetch(f.url, {
        method: "POST",
        headers: headers("priya-laptop"),
        body: shareBody(f.contentId),
      });

    const first = (await (await post()).json()) as {
      itemId: string;
      deduped: boolean;
    };
    const again = (await (await post()).json()) as {
      itemId: string;
      deduped: boolean;
    };

    expect(again.itemId).toBe(first.itemId);
    expect(again.deduped).toBe(true);
    expect(countIn(f.familyVault, "core_content_item")).toBe(1);
    expect(countIn(f.familyVault, "core_share_origin")).toBe(1);
  });

  test("unshare removes the projection; the origin row and bytes stay readable", async () => {
    const f = await harness();
    const shared = (await (
      await fetch(f.url, {
        method: "POST",
        headers: headers("priya-laptop"),
        body: shareBody(f.contentId),
      })
    ).json()) as { itemId: string };

    const removed = await fetch(`${f.url}/remove`, {
      method: "POST",
      headers: headers("priya-laptop"),
      body: JSON.stringify({
        audienceVaultId: "vault-family",
        itemType: "core.content_item",
        itemId: shared.itemId,
      }),
    });

    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ removed: true });
    expect(countIn(f.familyVault, "core_content_item")).toBe(0);
    expect(countIn(f.priyaVault, "core_content_item")).toBe(1);
    expect(
      f.priyaVault.blobs.getSync(f.priyaVault.blobs.local.listSync()[0]!)
    ).toStrictEqual(f.bytes);
  });

  // ---------------------------------------------------------------------------
  // The authorization matrix
  // ---------------------------------------------------------------------------

  test("a read-only member of the audience may not place anything into it", async () => {
    const f = await harness();
    // Sid can see Family — he simply may not write there. Give him read on
    // Priya's vault too, so the ONLY thing refusing him is the audience role.
    f.enrollments.members.setGrant(f.sid, "vault-priya", "read");

    const response = await fetch(f.url, {
      method: "POST",
      headers: headers("sid-phone"),
      body: shareBody(f.contentId),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "forbidden",
    });
    expect(countIn(f.familyVault, "core_content_item")).toBe(0);
  });

  test("a member with no grant in the origin cannot place out of it", async () => {
    const f = await harness();
    // Sid may write into Family, but holds nothing in Priya's vault — a vault he
    // cannot see reads as unknown, so the refusal leaks no household topology.
    f.enrollments.members.setGrant(f.sid, "vault-family", "write");

    const response = await fetch(f.url, {
      method: "POST",
      headers: headers("sid-phone"),
      body: shareBody(f.contentId),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
    expect(countIn(f.familyVault, "core_content_item")).toBe(0);
  });

  test("a read-only member cannot unshare either", async () => {
    const f = await harness();
    const shared = (await (
      await fetch(f.url, {
        method: "POST",
        headers: headers("priya-laptop"),
        body: shareBody(f.contentId),
      })
    ).json()) as { itemId: string };

    const response = await fetch(`${f.url}/remove`, {
      method: "POST",
      headers: headers("sid-phone"),
      body: JSON.stringify({
        audienceVaultId: "vault-family",
        itemType: "core.content_item",
        itemId: shared.itemId,
      }),
    });

    expect(response.status).toBe(403);
    expect(countIn(f.familyVault, "core_content_item")).toBe(1);
  });

  test("host custody may place without holding any member role", async () => {
    const f = await harness();

    const response = await fetch(f.url, {
      method: "POST",
      headers: headers(undefined, true),
      body: shareBody(f.contentId),
    });

    expect(response.status).toBe(200);
    expect(countIn(f.familyVault, "core_content_item")).toBe(1);
  });

  test("an unproved caller is refused before any vault is resolved", async () => {
    const f = await harness();

    const response = await fetch(f.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: shareBody(f.contentId),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "forbidden",
    });
    expect(countIn(f.familyVault, "core_content_item")).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Typed, fail-closed refusals
  // ---------------------------------------------------------------------------

  test("an unshareable item type is refused by name, with nothing placed", async () => {
    const f = await harness();

    const response = await fetch(f.url, {
      method: "POST",
      headers: headers("priya-laptop"),
      body: JSON.stringify({
        originVaultId: "vault-priya",
        audienceVaultId: "vault-family",
        itemType: "core.party",
        itemId: f.contentId,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_item_type",
    });
    expect(f.familyVault.blobs.local.listSync()).toStrictEqual([]);
  });

  test("an item that is not in the origin vault refuses before anything is placed", async () => {
    const f = await harness();

    const response = await fetch(f.url, {
      method: "POST",
      headers: headers("priya-laptop"),
      body: shareBody("no-such-item"),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "share_placement_failed",
    });
    expect(f.familyVault.blobs.local.listSync()).toStrictEqual([]);
  });

  test("an unknown audience vault is refused as not found", async () => {
    const f = await harness();

    const response = await fetch(f.url, {
      method: "POST",
      headers: headers("priya-laptop"),
      body: JSON.stringify({
        originVaultId: "vault-priya",
        audienceVaultId: "vault-nowhere",
        itemType: "core.content_item",
        itemId: f.contentId,
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  test("GET is not a share verb", async () => {
    const f = await harness();

    const response = await fetch(f.url, { headers: headers("priya-laptop") });

    expect(response.status).toBe(405);
  });
});
