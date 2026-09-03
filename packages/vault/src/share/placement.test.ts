import { statSync } from "node:fs";
import path from "node:path";

import { describe, afterEach, expect, test } from "vitest";

import { plainSqliteRow, plainSqliteRows } from "@centraid/test-kit/sqlite";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { FsBlobStore } from "../blob/local.js";
import {
  casPath,
  closeOpenVaults,
  household,
  seedPhoto,
  placementAuthority,
} from "./placement-fixture.js";
import {
  moveOutOfVault,
  readShareOrigin,
  shareItemsToVault,
} from "./placement.js";

describe("placement suite", () => {
  afterEach(closeOpenVaults);

  test("a share projects the item into the audience vault and leaves the origin untouched", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "a");
    const originBefore = plainSqliteRow(
      origin.vault
        .prepare("SELECT * FROM media_asset WHERE asset_id = ?")
        .get(photo.assetId)
    );

    const result = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
      now: () => 1_700_000_000_000,
    });

    const projected = audience.vault
      .prepare(
        `SELECT a.asset_id, a.kind, a.width, a.place_id, a.camera_device_id,
              c.title, c.sha256, c.creator_party_id, c.origin_device_id
         FROM media_asset a JOIN core_content_item c ON c.content_id = a.content_id
        WHERE a.asset_id = ?`
      )
      .get(result.items[0]!.itemId) as Record<string, unknown>;
    expect(projected.kind).toBe("photo");
    expect(projected.title).toBe("Photo a");
    expect(projected.sha256).toBe(photo.sha256);
    expect(
      audience.vault
        .prepare(
          "SELECT count(*) AS n FROM core_tag WHERE target_type = 'media.asset' AND target_id = ?"
        )
        .get(result.items[0]!.itemId)
    ).toMatchObject({ n: 0 });
    expect(projected.width).toBe(800);
    expect(projected.creator_party_id).toBeNull();
    expect(projected.origin_device_id).toBeNull();
    expect(projected.camera_device_id).toBeNull();
    expect(
      plainSqliteRows(
        audience.vault
          .prepare(
            "SELECT sha256 FROM core_content_derivative WHERE content_id IS NOT NULL"
          )
          .all()
      )
    ).toStrictEqual([{ sha256: photo.thumbSha }]);
    expect(audience.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
    expect(audience.blobs.getSync(photo.thumbSha)).toStrictEqual(
      photo.thumbBytes
    );

    expect(
      readShareOrigin(audience.vault, "media.asset", result.items[0]!.itemId)
    ).toStrictEqual({
      itemType: "media.asset",
      itemId: result.items[0]!.itemId,
      originVaultId: "vault-priya",
      originItemId: photo.assetId,
      sharedBy: "member-priya",
      sharedAt: 1_700_000_000_000,
    });

    expect(
      plainSqliteRow(
        origin.vault
          .prepare("SELECT * FROM media_asset WHERE asset_id = ?")
          .get(photo.assetId)
      )
    ).toStrictEqual(originBefore);
    expect(
      plainSqliteRow(
        origin.vault
          .prepare("SELECT COUNT(*) AS n FROM core_share_origin")
          .get()
      )
    ).toStrictEqual({
      n: 0,
    });
    expect(origin.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
  });

  test("reusing the origin id keeps the projection addressable by the same uuidv7", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "b");

    const result = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
    });

    expect(result.items[0]!.itemId).toBe(photo.assetId);
    expect(
      plainSqliteRow(
        audience.vault
          .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
          .get(photo.sha256)
      )
    ).toStrictEqual({ content_id: photo.contentId });
  });

  test("a same-filesystem share HARDLINKS the bytes — same inode, link count 2", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "c");
    const originStat = statSync(casPath(origin, photo.sha256));
    expect(originStat.nlink).toBe(1);

    const result = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
    });

    expect(result.blobs.map((b) => b.mode)).toStrictEqual(["linked", "linked"]);
    for (const sha of [photo.sha256, photo.thumbSha]) {
      const from = statSync(casPath(origin, sha));
      const to = statSync(casPath(audience, sha));
      expect(to.ino).toBe(from.ino);
      expect(to.dev).toBe(from.dev);
      expect(from.nlink).toBe(2);
      expect(to.nlink).toBe(2);
    }
  });

  test("the copy fallback yields identical bytes when the filesystem refuses to link", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "d");
    audience.blobs.local.linkFromSync = () => "unsupported";

    const result = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
    });

    expect(result.blobs.map((b) => b.mode)).toStrictEqual(["copied", "copied"]);
    for (const [sha, bytes] of [
      [photo.sha256, photo.bytes],
      [photo.thumbSha, photo.thumbBytes],
    ] as const) {
      const from = statSync(casPath(origin, sha));
      const to = statSync(casPath(audience, sha));
      expect(to.ino).not.toBe(from.ino); // a separate inode — bytes were copied
      expect(from.nlink).toBe(1);
      expect(to.nlink).toBe(1);
      expect(audience.blobs.getSync(sha)).toStrictEqual(bytes);
    }
  });

  test("linkFromSync classifies a refusing link as unsupported and rethrows anything else", () => {
    const root = tempDirSync("centraid-link-");
    const store = new FsBlobStore(path.join(root, "blobs"));
    const sha = "a".repeat(64);
    expect(store.linkFromSync(sha, root)).toBe("unsupported");
    expect(store.hasSync(sha)).toBe(false);
    expect(() =>
      store.linkFromSync("b".repeat(64), path.join(root, "nope"))
    ).toThrow(/ENOENT/u);
  });

  test("re-sharing the same item is idempotent — same member and a different member", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "e");
    const share = (member: string, at: number) =>
      shareItemsToVault({
        origin,
        originVaultId: "vault-priya",
        audience,
        itemType: "media.asset",
        itemIds: [photo.assetId],
        sharedBy: member,
        authority: placementAuthority(origin, "media.asset", [photo.assetId]),
        now: () => at,
      });

    const first = share("member-priya", 1_000);
    const again = share("member-priya", 2_000);
    const bySid = share("member-sid", 3_000);

    expect(again.items[0]!.itemId).toBe(first.items[0]!.itemId);
    expect(bySid.items[0]!.itemId).toBe(first.items[0]!.itemId);
    expect(again.items[0]!.deduped).toBe(true);
    expect(bySid.items[0]!.deduped).toBe(true);
    expect(
      plainSqliteRow(
        audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
      )
    ).toStrictEqual({
      n: 1,
    });
    expect(
      plainSqliteRow(
        audience.vault
          .prepare("SELECT COUNT(*) AS n FROM core_content_item")
          .get()
      )
    ).toStrictEqual({
      n: 1,
    });
    expect(
      plainSqliteRow(
        audience.vault
          .prepare("SELECT COUNT(*) AS n FROM core_content_derivative")
          .get()
      )
    ).toStrictEqual({
      n: 1,
    });
    const provenance = readShareOrigin(
      audience.vault,
      "media.asset",
      first.items[0]!.itemId
    )!;
    expect(provenance.sharedBy).toBe("member-priya");
    expect(provenance.sharedAt).toBe(1_000);
    expect(bySid.blobs.map((b) => b.mode)).toStrictEqual([
      "present",
      "present",
    ]);
  });

  test("documents project their current content and can move after target commit", () => {
    const { origin, originBoot, audience } = household();
    const content = seedPhoto(origin, originBoot, "document");
    const documentId = "019b0000-0000-7000-8000-000000000628";
    const now = "2026-07-29T00:00:00.000Z";
    origin.vault
      .prepare(
        `INSERT INTO core_document
           (document_id, title, current_content_id, created_at, updated_at,
            deleted_at, purge_at)
         VALUES (?, 'Offline plan', ?, ?, ?, NULL, NULL)`
      )
      .run(documentId, content.contentId, now, now);

    const placed = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "core.document",
      itemIds: [documentId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "core.document", [documentId]),
    });
    expect(
      plainSqliteRow(
        audience.vault
          .prepare(
            `SELECT d.document_id, d.title, c.sha256
               FROM core_document d
               JOIN core_content_item c
                 ON c.content_id = d.current_content_id
              WHERE d.document_id = ?`
          )
          .get(placed.items[0]!.itemId)
      )
    ).toStrictEqual({
      document_id: documentId,
      title: "Offline plan",
      sha256: content.sha256,
    });

    const moved = moveOutOfVault({
      source: origin,
      itemType: "core.document",
      itemId: documentId,
    });
    expect(moved.removed).toBe(true);
    expect(
      origin.vault
        .prepare("SELECT 1 FROM core_document WHERE document_id = ?")
        .get(documentId)
    ).toBeUndefined();
    expect(
      audience.vault
        .prepare("SELECT 1 FROM core_document WHERE document_id = ?")
        .get(documentId)
    ).toBeDefined();
  });
});
