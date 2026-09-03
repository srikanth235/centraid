// The packaged local orphan reclaim (#599 decision 11). Real vaults on
// real disk — the load-bearing claims are filesystem facts (which directory
// entry goes, which inode survives), so nothing here is mocked.

import { statSync } from "node:fs";

import { describe, afterEach, expect, test } from "vitest";

import {
  casPath,
  closeOpenVaults,
  household,
  reclaimOrphans,
  seedPhoto,
  placementAuthority,
} from "../share/placement-fixture.js";
import { shareItemsToVault, unshareFromVault } from "../share/placement.js";
import { sweepLocalOrphans } from "./local-orphan-sweep.js";

describe("local-orphan-sweep suite", () => {
  afterEach(closeOpenVaults);

  const DAY = 24 * 60 * 60 * 1000;

  test("an unshared blob is held for the grace window, then reclaimed", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "sweep-a");
    const shared = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
    });
    unshareFromVault({
      audience,
      itemType: "media.asset",
      itemId: shared.items[0]!.itemId,
    });

    // First sight tombstones, never deletes — the grace clock starts here.
    const first = sweepLocalOrphans(audience, {
      graceWindowMs: 3 * DAY,
      now: 1_000,
    });
    expect(first.deleted).toStrictEqual([]);
    expect(first.graceHeld.sort()).toStrictEqual(
      [photo.sha256, photo.thumbSha].sort()
    );
    expect(audience.blobs.hasSync(photo.sha256)).toBe(true);

    // Inside the window it is still held, and the clock does NOT reset.
    expect(
      sweepLocalOrphans(audience, {
        graceWindowMs: 3 * DAY,
        now: 1_000 + 2 * DAY,
      }).deleted
    ).toStrictEqual([]);

    const reclaimed = sweepLocalOrphans(audience, {
      graceWindowMs: 3 * DAY,
      now: 1_000 + 4 * DAY,
    });
    expect(reclaimed.deleted.sort()).toStrictEqual(
      [photo.sha256, photo.thumbSha].sort()
    );
    expect(audience.blobs.hasSync(photo.sha256)).toBe(false);
  });

  test("a live blob is never reclaimed, however long the sweep runs", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "sweep-b");

    for (const now of [1_000, 1_000 + 400 * DAY]) {
      const pass = sweepLocalOrphans(origin, { graceWindowMs: 0, now });
      expect(pass.deleted).toStrictEqual([]);
      expect(pass.graceHeld).toStrictEqual([]);
    }
    expect(origin.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
  });

  test("a caller-supplied extra root pins bytes the live model has already dropped", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "sweep-c");
    origin.vault
      .prepare("DELETE FROM media_asset WHERE asset_id = ?")
      .run(photo.assetId);
    origin.vault
      .prepare("DELETE FROM core_content_derivative WHERE content_id = ?")
      .run(photo.contentId);
    origin.vault
      .prepare("DELETE FROM core_content_item WHERE content_id = ?")
      .run(photo.contentId);

    const pinned = new Set([photo.sha256]);
    sweepLocalOrphans(origin, {
      graceWindowMs: 0,
      now: 1_000,
      extraLiveRoots: pinned,
    });
    const second = sweepLocalOrphans(origin, {
      graceWindowMs: 0,
      now: 2_000,
      extraLiveRoots: pinned,
    });

    expect(second.deleted).toStrictEqual([photo.thumbSha]);
    expect(origin.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
  });

  test("bytes shared by two rows survive until the FINAL reference is deleted", () => {
    const { origin, originBoot } = household();
    // Two rows over ONE blob. Originals cannot share a sha in one vault
    // (core_content_item.sha256 is UNIQUE), so the schema-legal shared-SHA
    // case is derivative rows: point photo B's thumb at photo A's thumb
    // bytes — one CAS entry, two `core_content_derivative` claims.
    const a = seedPhoto(origin, originBoot, "shared-thumb-a");
    const b = seedPhoto(origin, originBoot, "shared-thumb-b");
    origin.vault
      .prepare(
        "UPDATE core_content_derivative SET sha256 = ? WHERE content_id = ?"
      )
      .run(a.thumbSha, b.contentId);
    // B's own thumb bytes are now unclaimed; clear that noise first so every
    // assertion below is about the shared sha.
    expect(reclaimOrphans(origin)).toStrictEqual([b.thumbSha]);

    const dropPhoto = (photo: { assetId: string; contentId: string }): void => {
      origin.vault
        .prepare("DELETE FROM media_asset WHERE asset_id = ?")
        .run(photo.assetId);
      origin.vault
        .prepare("DELETE FROM core_content_derivative WHERE content_id = ?")
        .run(photo.contentId);
      origin.vault
        .prepare("DELETE FROM core_content_item WHERE content_id = ?")
        .run(photo.contentId);
    };

    // First reference gone: A's original orphans, but the SHARED thumb sha is
    // still claimed by B's derivative — never tombstoned, never held.
    dropPhoto(a);
    const held = sweepLocalOrphans(origin, {
      graceWindowMs: 3 * DAY,
      now: 10_000,
    });
    expect(held.deleted).toStrictEqual([]);
    expect(held.graceHeld).toStrictEqual([a.sha256]);
    const reclaimed = sweepLocalOrphans(origin, {
      graceWindowMs: 3 * DAY,
      now: 10_000 + 4 * DAY,
    });
    expect(reclaimed.deleted).toStrictEqual([a.sha256]);
    expect(origin.blobs.getSync(a.thumbSha)).toStrictEqual(a.thumbBytes);

    // FINAL reference gone: the shared sha drops out of the live set, is held
    // for the grace window on first sight, then reclaimed.
    dropPhoto(b);
    const firstSight = sweepLocalOrphans(origin, {
      graceWindowMs: 3 * DAY,
      now: 20_000,
    });
    expect(firstSight.deleted).toStrictEqual([]);
    expect(firstSight.graceHeld.sort()).toStrictEqual(
      [b.sha256, a.thumbSha].sort()
    );
    const final = sweepLocalOrphans(origin, {
      graceWindowMs: 3 * DAY,
      now: 20_000 + 4 * DAY,
    });
    expect(final.deleted.sort()).toStrictEqual([b.sha256, a.thumbSha].sort());
    expect(origin.blobs.hasSync(a.thumbSha)).toBe(false);
  });

  test("reclaiming one vault never takes bytes another vault still links", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "sweep-d");
    shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
    });
    const sharedIno = statSync(casPath(audience, photo.sha256)).ino;

    // The owner deletes the photo from their own library; their sweep now sees
    // the bytes as orphaned HERE and unlinks their own directory entry.
    origin.vault
      .prepare("DELETE FROM media_asset WHERE asset_id = ?")
      .run(photo.assetId);
    origin.vault
      .prepare("DELETE FROM core_content_derivative WHERE content_id = ?")
      .run(photo.contentId);
    origin.vault
      .prepare("DELETE FROM core_content_item WHERE content_id = ?")
      .run(photo.contentId);
    sweepLocalOrphans(origin, { graceWindowMs: 0, now: 1_000 });
    const reclaimed = sweepLocalOrphans(origin, {
      graceWindowMs: 0,
      now: 2_000,
    });

    expect(reclaimed.deleted.sort()).toStrictEqual(
      [photo.sha256, photo.thumbSha].sort()
    );
    expect(origin.blobs.hasSync(photo.sha256)).toBe(false);
    // The family's copy reads exactly as before — same inode, still one link.
    expect(audience.blobs.getSync(photo.sha256)).toStrictEqual(photo.bytes);
    expect(statSync(casPath(audience, photo.sha256)).ino).toBe(sharedIno);
    expect(
      sweepLocalOrphans(audience, { graceWindowMs: 0, now: 2_000 }).deleted
    ).toStrictEqual([]);
  });

  // ── issue #659 L5: a pass is bounded and resumable ────────────────────

  test("a bounded pass examines its window and resumes where it stopped", () => {
    const { origin, originBoot } = household();
    const photos = [
      seedPhoto(origin, originBoot, "window-a"),
      seedPhoto(origin, originBoot, "window-b"),
      seedPhoto(origin, originBoot, "window-c"),
    ];
    // Orphan every one of them (two CAS entries each: original + thumb).
    for (const photo of photos) {
      origin.vault
        .prepare("DELETE FROM media_asset WHERE asset_id = ?")
        .run(photo.assetId);
      origin.vault
        .prepare("DELETE FROM core_content_derivative WHERE content_id = ?")
        .run(photo.contentId);
      origin.vault
        .prepare("DELETE FROM core_content_item WHERE content_id = ?")
        .run(photo.contentId);
    }
    const orphans = photos
      .flatMap((p) => [p.sha256, p.thumbSha])
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // First pass: tombstone only the first two entries.
    const first = sweepLocalOrphans(origin, {
      graceWindowMs: 0,
      now: 1_000,
      maxEntries: 2,
    });
    expect(first.examined).toBe(2);
    expect(first.graceHeld).toStrictEqual(orphans.slice(0, 2));
    expect(first.nextCursor).toBe(orphans[1]);

    // Walk the rest of the directory from the cursor, two at a time.
    let cursor = first.nextCursor;
    const seen = [...first.graceHeld];
    while (cursor !== null) {
      const pass = sweepLocalOrphans(origin, {
        graceWindowMs: 0,
        now: 1_000,
        maxEntries: 2,
        cursor,
      });
      seen.push(...pass.graceHeld);
      cursor = pass.nextCursor;
    }
    expect(seen).toStrictEqual(orphans);
    // Nothing was deleted yet: every entry was seen exactly once, so every
    // one of them is still inside its first-sight grace.
    expect(orphans.every((sha) => origin.blobs.hasSync(sha))).toBe(true);

    // A second full walk past the grace window reclaims them all.
    const reclaimed = sweepLocalOrphans(origin, {
      graceWindowMs: 0,
      now: 2_000,
    });
    expect(reclaimed.deleted.sort()).toStrictEqual(orphans);
    expect(reclaimed.nextCursor).toBeNull();
  });

  test("a zero-width window is refused rather than silently sweeping nothing", () => {
    const { origin } = household();
    expect(() =>
      sweepLocalOrphans(origin, { graceWindowMs: 0, maxEntries: 0 })
    ).toThrow(/maxEntries/u);
  });
});
