import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import { sealAad, sealValue, unsealValue } from "../schema/sealed.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";
import { shareToVault, unshareFromVault } from "./placement.js";

describe("household audience placement", () => {
  afterEach(closeOpenVaults);

  test("shares and revokes an album as one independent collection", () => {
    const { origin, originBoot, audience } = household();
    const first = seedPhoto(origin, originBoot, "album-a");
    const second = seedPhoto(origin, originBoot, "album-b");
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
       VALUES (?, ?, 'media.media_asset', ?, ?, ?)`
    );
    add.run(uuidv7(), collectionId, first.assetId, 0, now);
    add.run(uuidv7(), collectionId, second.assetId, 1, now);

    const shared = shareToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "core.collection",
      itemId: collectionId,
      sharedBy: "member-priya",
    });

    expect(
      audience.vault
        .prepare(
          `SELECT c.name, COUNT(e.entry_id) AS entries
             FROM core_collection c
             LEFT JOIN core_collection_entry e USING (collection_id)
            WHERE c.collection_id = ?
            GROUP BY c.collection_id`
        )
        .get(shared.itemId)
    ).toMatchObject({ name: "Summer", entries: 2 });
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM media_media_asset")
        .get()
    ).toMatchObject({ n: 2 });

    expect(
      unshareFromVault({
        audience,
        itemType: "core.collection",
        itemId: shared.itemId,
      }).removed
    ).toBe(true);
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM media_media_asset")
        .get()
    ).toMatchObject({ n: 0 });
  });

  test("shares an album when the cover bytes already exist under another content id", () => {
    const { origin, originBoot, audience } = household();
    const first = seedPhoto(origin, originBoot, "cover-dedupe");
    // Pre-seed the same bytes in the audience under a different content id so
    // projection dedupes by sha256 — the album cover must use that audience id.
    const foreignContentId = uuidv7();
    const now = nowIso();
    const originContent = origin.vault
      .prepare(
        "SELECT media_type, content_uri, sha256, byte_size, title, language, created_at FROM core_content_item WHERE content_id = ?"
      )
      .get(first.contentId) as {
      media_type: string;
      content_uri: string;
      sha256: string;
      byte_size: number;
      title: string | null;
      language: string | null;
      created_at: string;
    };
    audience.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language,
            creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`
      )
      .run(
        foreignContentId,
        originContent.media_type,
        originContent.content_uri,
        originContent.sha256,
        originContent.byte_size,
        originContent.title,
        originContent.language,
        now
      );
    const collectionId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_collection
           (collection_id, owner_party_id, name, cover_content_id,
            parent_collection_id, sort_order, created_at)
         VALUES (?, ?, 'Dedupe cover', ?, NULL, 0, ?)`
      )
      .run(collectionId, originBoot.ownerPartyId, first.contentId, now);
    origin.vault
      .prepare(
        `INSERT INTO core_collection_entry
           (entry_id, collection_id, target_type, target_id, position, added_at)
         VALUES (?, ?, 'media.media_asset', ?, 0, ?)`
      )
      .run(uuidv7(), collectionId, first.assetId, now);

    const shared = shareToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "core.collection",
      itemId: collectionId,
      sharedBy: "member-priya",
    });

    expect(
      audience.vault
        .prepare(
          "SELECT cover_content_id FROM core_collection WHERE collection_id = ?"
        )
        .get(shared.itemId)
    ).toMatchObject({ cover_content_id: foreignContentId });
  });

  test("re-encrypts a family Locker item under the audience vault key", () => {
    const { origin, audience } = household();
    const itemId = uuidv7();
    const now = nowIso();
    const password = sealValue(
      origin.sealKey,
      sealAad("locker_item", "password", itemId),
      "correct horse battery staple"
    );
    origin.vault
      .prepare(
        `INSERT INTO locker_item
           (item_id, type, title, username, password, url, url_match_policy,
            compromised, created_at, updated_at)
         VALUES (?, 'login', 'Family router', 'admin', ?, 'https://router.home',
                 'exact-host', 0, ?, ?)`
      )
      .run(itemId, password, now, now);

    const shared = shareToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "locker.item",
      itemId,
      sharedBy: "member-priya",
    });
    const row = audience.vault
      .prepare(
        "SELECT password, connection_id FROM locker_item WHERE item_id = ?"
      )
      .get(shared.itemId) as {
      password: string;
      connection_id: string | null;
    };
    expect(row.password).not.toBe(password);
    expect(row.connection_id).toBeNull();
    expect(
      unsealValue(
        audience.sealKey,
        sealAad("locker_item", "password", shared.itemId),
        row.password
      )
    ).toBe("correct horse battery staple");
  });

  test("shares a Tally group without turning accounting parties into principals", () => {
    const { origin, originBoot, audience } = household();
    const now = nowIso();
    const friendId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, birth_date,
            avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', 'Sid', 'Sid', NULL, NULL, ?, ?, 'v0')`
      )
      .run(friendId, now, now);
    const circleId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO social_circle
           (circle_id, owner_party_id, name, kind)
         VALUES (?, ?, 'House trip', 'family')`
      )
      .run(circleId, originBoot.ownerPartyId);
    const addMember = origin.vault.prepare(
      `INSERT INTO social_circle_member
         (member_id, circle_id, party_id, added_at) VALUES (?, ?, ?, ?)`
    );
    addMember.run(uuidv7(), circleId, originBoot.ownerPartyId, now);
    addMember.run(uuidv7(), circleId, friendId, now);
    const groupId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO tally_group
           (group_id, circle_id, icon, color, created_at, updated_at)
         VALUES (?, ?, '🏠', '#336699', ?, ?)`
      )
      .run(groupId, circleId, now, now);
    const expenseId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO tally_expense
           (expense_id, group_id, description, amount_minor, paid_by, spent_on,
            category, txn_id, created_at, updated_at)
         VALUES (?, ?, 'Groceries', 4200, ?, '2026-07-29', 'groceries',
                 NULL, ?, ?)`
      )
      .run(expenseId, groupId, originBoot.ownerPartyId, now, now);
    const split = origin.vault.prepare(
      `INSERT INTO tally_expense_split
         (expense_id, party_id, share_minor, updated_at) VALUES (?, ?, ?, ?)`
    );
    split.run(expenseId, originBoot.ownerPartyId, 2100, now);
    split.run(expenseId, friendId, 2100, now);

    const shared = shareToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "tally.group",
      itemId: groupId,
      sharedBy: "gateway-member-priya",
    });

    expect(
      audience.vault
        .prepare(
          `SELECT g.icon, c.name, COUNT(m.member_id) AS accounting_parties
             FROM tally_group g
             JOIN social_circle c USING (circle_id)
             JOIN social_circle_member m USING (circle_id)
            WHERE g.group_id = ?
            GROUP BY g.group_id`
        )
        .get(shared.itemId)
    ).toMatchObject({
      icon: "🏠",
      name: "House trip",
      accounting_parties: 2,
    });
    expect(
      audience.vault
        .prepare(
          "SELECT SUM(share_minor) AS total FROM tally_expense_split WHERE expense_id = ?"
        )
        .get(expenseId)
    ).toMatchObject({ total: 4200 });
  });
});
