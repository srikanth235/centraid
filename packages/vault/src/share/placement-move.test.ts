// SAME-OWNER PLACEMENT AS ONE CALL (#928 A7). The give plane's edge rows,
// effect outbox, reducer, routes and retry sweep are deleted; what is left is
// this: project into the destination, then release the source. The album is
// the case the machinery existed for — one act over a set — so it is the case
// asserted here, from both ends and in both directions.

import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";
import type { Household } from "./placement-fixture.js";
import { placeItemsInVault } from "./placement.js";

function seedAlbum(house: Household): {
  collectionId: string;
  assets: string[];
} {
  const { origin, originBoot } = house;
  const first = seedPhoto(origin, originBoot, "move-a");
  const second = seedPhoto(origin, originBoot, "move-b");
  const collectionId = uuidv7();
  const now = nowIso();
  origin.vault
    .prepare(
      `INSERT INTO core_collection
         (collection_id, owner_party_id, name, cover_content_id,
          parent_collection_id, sort_order, created_at)
       VALUES (?, ?, 'Summer', ?, NULL, 0, ?)`
    )
    .run(collectionId, originBoot.ownerPartyId, first.contentId, now);
  const add = origin.vault.prepare(
    `INSERT INTO core_collection_entry
       (entry_id, collection_id, target_type, target_id, position, added_at)
     VALUES (?, ?, 'media.asset', ?, ?, ?)`
  );
  add.run(uuidv7(), collectionId, first.assetId, 0, now);
  add.run(uuidv7(), collectionId, second.assetId, 1, now);
  return { collectionId, assets: [first.assetId, second.assetId] };
}

function albumEntries(db: Household["origin"], collectionId: string): unknown {
  return db.vault
    .prepare(
      `SELECT c.name, COUNT(e.entry_id) AS entries
         FROM core_collection c
         LEFT JOIN core_collection_entry e USING (collection_id)
        WHERE c.collection_id = ?
        GROUP BY c.collection_id`
    )
    .get(collectionId);
}

describe("moving an album between two of the owner's vaults", () => {
  afterEach(closeOpenVaults);

  test("is ONE call: the album lands whole in the destination and leaves the source", () => {
    const house = household();
    const { collectionId, assets } = seedAlbum(house);

    const placed = placeItemsInVault({
      kind: "move",
      origin: house.origin,
      originVaultId: "vault-priya",
      audience: house.audience,
      audiencePartyId: house.audienceBoot.ownerPartyId,
      itemType: "core.collection",
      itemIds: [collectionId],
      sharedBy: "member-priya",
    });

    expect(placed.targetItemIds).toHaveLength(1);
    expect(
      albumEntries(house.audience, placed.targetItemIds[0]!)
    ).toMatchObject({ name: "Summer", entries: 2 });
    // The source released the WHOLE album, not the collection row alone.
    expect(albumEntries(house.origin, collectionId)).toBeUndefined();
    for (const assetId of assets) {
      expect(
        house.origin.vault
          .prepare("SELECT 1 FROM media_asset WHERE asset_id = ?")
          .get(assetId)
      ).toBeUndefined();
    }
    expect(
      house.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM media_asset")
        .get()
    ).toMatchObject({ n: 2 });
  });

  test("an `add` places without releasing the source", () => {
    const house = household();
    const { collectionId } = seedAlbum(house);

    const placed = placeItemsInVault({
      kind: "add",
      origin: house.origin,
      originVaultId: "vault-priya",
      audience: house.audience,
      audiencePartyId: house.audienceBoot.ownerPartyId,
      itemType: "core.collection",
      itemIds: [collectionId],
      sharedBy: "member-priya",
    });

    expect(albumEntries(house.origin, collectionId)).toMatchObject({
      entries: 2,
    });
    expect(
      albumEntries(house.audience, placed.targetItemIds[0]!)
    ).toMatchObject({ entries: 2 });
    expect(placed.orphanedShas).toStrictEqual([]);
  });

  test("the placement mints its own authority — no caller threads one in", () => {
    const house = household();
    const { collectionId } = seedAlbum(house);
    expect(
      house.origin.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_authority
            WHERE subject_type = 'core.collection' AND subject_id = ?
              AND decision = 'granted' AND revoked_at IS NULL`
        )
        .get(collectionId)
    ).toMatchObject({ n: 0 });

    placeItemsInVault({
      kind: "add",
      origin: house.origin,
      originVaultId: "vault-priya",
      audience: house.audience,
      audiencePartyId: house.audienceBoot.ownerPartyId,
      itemType: "core.collection",
      itemIds: [collectionId],
      sharedBy: "member-priya",
    });

    expect(
      house.origin.vault
        .prepare(
          `SELECT principal_id FROM share_authority
            WHERE subject_type = 'core.collection' AND subject_id = ?
              AND revoked_at IS NULL`
        )
        .get(collectionId)
    ).toMatchObject({ principal_id: house.audienceBoot.ownerPartyId });
  });

  test("a move ends the answer it minted — the subject left the vault", () => {
    const house = household();
    const { collectionId } = seedAlbum(house);
    placeItemsInVault({
      kind: "move",
      origin: house.origin,
      originVaultId: "vault-priya",
      audience: house.audience,
      audiencePartyId: house.audienceBoot.ownerPartyId,
      itemType: "core.collection",
      itemIds: [collectionId],
      sharedBy: "member-priya",
    });

    // The purge trigger on `core_entity` revokes every live answer about a
    // purged subject; a moved album is purged from the source, so its
    // placement answer must not still stand there.
    expect(
      house.origin.vault
        .prepare(
          `SELECT revoked_reason FROM share_authority
            WHERE subject_type = 'core.collection' AND subject_id = ?`
        )
        .get(collectionId)
    ).toMatchObject({ revoked_reason: "subject-purged" });
  });
});
