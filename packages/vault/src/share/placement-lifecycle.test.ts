import { statSync } from "node:fs";
// Share-by-placement lifecycle: failure atomicity, unshare, and the GC
// interplay between vaults that hardlink the same inode (issue #599 d11).

import { describe, afterEach, expect, test } from "vitest";

import { plainSqliteRow } from "@centraid/test-kit/sqlite";

import { sweepLocalOrphans } from "../blob/local-orphan-sweep.js";
import { liveBlobShas } from "../blob/read.js";
import {
  casPath,
  closeOpenVaults,
  household,
  reclaimOrphans,
  seedPhoto,
} from "./placement-fixture.js";
import {
  readShareOrigin,
  shareItemsToVault,
  unshareFromVault,
} from "./placement.js";

describe("placement-lifecycle suite", () => {
  afterEach(closeOpenVaults);

  // ───────────────────────────────────────────────────────────────────────────
  // Failure atomicity
  // ───────────────────────────────────────────────────────────────────────────

  test("an injected mid-share failure leaves the origin clean and only a reclaimable orphan", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "f");
    const realPrepare = audience.vault.prepare.bind(audience.vault);
    audience.vault.prepare = ((sql: string) => {
      if (sql.includes("core_share_origin"))
        throw new Error("injected mid-share failure");
      return realPrepare(sql);
    }) as typeof audience.vault.prepare;

    expect(() =>
      shareItemsToVault({
        origin,
        originVaultId: "vault-priya",
        audience,
        itemType: "media.asset",
        itemIds: [photo.assetId],
        sharedBy: "member-priya",
      })
    ).toThrow("injected mid-share failure");
    audience.vault.prepare = realPrepare;

    // The origin is untouched — it was never written in the first place.
    expect(
      plainSqliteRow(
        origin.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
      )
    ).toStrictEqual({
      n: 1,
    });
    expect(origin.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
    // The audience transaction rolled back whole: no half-placed item.
    expect(
      plainSqliteRow(
        audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
      )
    ).toStrictEqual({
      n: 0,
    });
    expect(
      plainSqliteRow(
        audience.vault
          .prepare("SELECT COUNT(*) AS n FROM core_content_item")
          .get()
      )
    ).toStrictEqual({
      n: 0,
    });
    expect(
      plainSqliteRow(
        audience.vault
          .prepare("SELECT COUNT(*) AS n FROM core_share_origin")
          .get()
      )
    ).toStrictEqual({
      n: 0,
    });

    // What IS left is the orphaned link, claimed by nothing in the model.
    expect(audience.blobs.hasSync(photo.sha256)).toBe(true);
    expect(liveBlobShas(audience.vault).has(photo.sha256)).toBe(false);

    // The orphan-grace rule HOLDS it on first sight, then reclaims it once the
    // recovery window has elapsed.
    const day = 24 * 60 * 60 * 1000;
    const held = sweepLocalOrphans(audience, {
      graceWindowMs: 3 * day,
      now: 1_000,
    });
    expect(held.deleted).toStrictEqual([]);
    expect(held.graceHeld.sort()).toStrictEqual(
      [photo.sha256, photo.thumbSha].sort()
    );
    expect(audience.blobs.hasSync(photo.sha256)).toBe(true);
    const reclaimed = sweepLocalOrphans(audience, {
      graceWindowMs: 3 * day,
      now: 1_000 + 4 * day,
    }).deleted;
    expect(reclaimed.sort()).toStrictEqual(
      [photo.sha256, photo.thumbSha].sort()
    );
    expect(audience.blobs.hasSync(photo.sha256)).toBe(false);
    // Reclaiming the audience's directory entry never touched the origin's.
    expect(origin.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
    expect(statSync(casPath(origin, photo.sha256)).nlink).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Unshare + GC interplay
  // ───────────────────────────────────────────────────────────────────────────

  test("unshare removes the projection; the origin row and bytes stay readable", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "g");
    const shared = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
    });
    const originalIno = statSync(casPath(origin, photo.sha256)).ino;

    const result = unshareFromVault({
      audience,
      itemType: "media.asset",
      itemId: shared.items[0]!.itemId,
    });

    expect(result.removed).toBe(true);
    expect(result.orphanedShas.sort()).toStrictEqual(
      [photo.sha256, photo.thumbSha].sort()
    );
    expect(
      plainSqliteRow(
        audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
      )
    ).toStrictEqual({
      n: 0,
    });
    expect(
      plainSqliteRow(
        audience.vault
          .prepare("SELECT COUNT(*) AS n FROM core_content_item")
          .get()
      )
    ).toStrictEqual({
      n: 0,
    });
    expect(
      readShareOrigin(audience.vault, "media.asset", shared.items[0]!.itemId)
    ).toBeUndefined();
    // The bytes are still linked here until the audience's GC runs — and the
    // origin is untouched either way.
    expect(
      plainSqliteRow(
        origin.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
      )
    ).toStrictEqual({
      n: 1,
    });
    expect(origin.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);

    // The last unlink: the audience drops its directory entry, the origin's
    // entry survives, and the inode is the SAME one it always was.
    reclaimOrphans(audience);
    expect(audience.blobs.hasSync(photo.sha256)).toBe(false);
    const after = statSync(casPath(origin, photo.sha256));
    expect(after.nlink).toBe(1);
    expect(after.ino).toBe(originalIno);
    expect(origin.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
  });

  test("re-sharing after an unshare works again, idempotently", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "h");
    const share = () =>
      shareItemsToVault({
        origin,
        originVaultId: "vault-priya",
        audience,
        itemType: "media.asset",
        itemIds: [photo.assetId],
        sharedBy: "member-sid",
      });

    share();
    unshareFromVault({
      audience,
      itemType: "media.asset",
      itemId: photo.assetId,
    });
    reclaimOrphans(audience);
    const again = share();

    expect(again.items[0]!.deduped).toBe(false);
    expect(again.blobs.map((b) => b.mode)).toStrictEqual(["linked", "linked"]);
    expect(audience.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
    expect(
      readShareOrigin(audience.vault, "media.asset", again.items[0]!.itemId)
        ?.sharedBy
    ).toBe("member-sid");
  });

  test("unshare refuses a row the audience authored itself — no provenance, no delete", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    seedPhoto(origin, originBoot, "i");
    const own = seedPhoto(audience, audienceBoot, "own");

    const result = unshareFromVault({
      audience,
      itemType: "media.asset",
      itemId: own.assetId,
    });

    expect(result).toStrictEqual({ removed: false, orphanedShas: [] });
    expect(
      plainSqliteRow(
        audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
      )
    ).toStrictEqual({
      n: 1,
    });
  });

  test("the origin's orphan sweep cannot delete bytes the audience still links", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "j");
    shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
    });

    // The owner trashes the photo out of their OWN library: rows gone, so the
    // origin's sweep now sees the bytes as orphaned and unlinks its entry.
    origin.vault
      .prepare("DELETE FROM media_asset WHERE asset_id = ?")
      .run(photo.assetId);
    origin.vault
      .prepare("DELETE FROM core_content_derivative WHERE content_id = ?")
      .run(photo.contentId);
    origin.vault
      .prepare("DELETE FROM core_content_item WHERE content_id = ?")
      .run(photo.contentId);
    const reclaimed = reclaimOrphans(origin);

    expect(reclaimed.sort()).toStrictEqual(
      [photo.sha256, photo.thumbSha].sort()
    );
    expect(origin.blobs.hasSync(photo.sha256)).toBe(false);
    // The inode survived: the audience still holds its own directory entry, so
    // the family's copy of the photo reads exactly as before.
    expect(audience.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
    expect(audience.blobs.getSync(photo.thumbSha)).toStrictEqual(
      photo.thumbBytes
    );
    expect(statSync(casPath(audience, photo.sha256)).nlink).toBe(1);

    // And only after the LAST vault unlinks does the content actually go.
    unshareFromVault({
      audience,
      itemType: "media.asset",
      itemId: photo.assetId,
    });
    reclaimOrphans(audience);
    expect(audience.blobs.hasSync(photo.sha256)).toBe(false);
    expect(audience.blobs.localPathSync(photo.sha256)).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Guards
  // ───────────────────────────────────────────────────────────────────────────

  test("sharing an unknown item is refused before anything is placed", () => {
    const { origin, audience } = household();

    expect(() =>
      shareItemsToVault({
        origin,
        originVaultId: "vault-priya",
        audience,
        itemType: "media.asset",
        itemIds: ["missing"],
        sharedBy: "member-priya",
      })
    ).toThrow(/is not in the origin vault/u);
    expect(audience.blobs.local.listSync()).toStrictEqual([]);
  });

  test("a vault cannot be shared into itself", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "k");

    expect(() =>
      shareItemsToVault({
        origin,
        originVaultId: "vault-priya",
        audience: origin,
        itemType: "media.asset",
        itemIds: [photo.assetId],
        sharedBy: "member-priya",
      })
    ).toThrow(/into itself/u);
  });
});
