/*
 * CONFINEMENT is the sharing plane's one security law (issues #726 / #750).
 *
 * Every other property of a closure — pooling, idempotence, the wire path —
 * is about what a share DOES carry, and those are owned elsewhere
 * (`closure-split.test.ts`, `placement.test.ts`). This file owns the opposite
 * claim, which nothing else in the suite makes: what a closure must NOT
 * carry. An owner who shares one photograph out of a library of ten thousand
 * is making a statement about the other 9,999, and a closure that quietly
 * widened — a dropped `WHERE`, a recursion that walked one edge too far, a
 * partial result returned after a bad id — would be a privacy failure that
 * every "the shared item arrived" test still passes.
 *
 * Read-only by construction (read-closure.ts writes nothing), so these run
 * against one real on-disk origin vault and assert on the `WireClosure` value
 * itself: it is exactly what would cross the wire.
 */

import { afterEach, describe, expect, test } from "vitest";

import { registerDocumentCommands } from "../commands/documents.js";
import { VaultShareError } from "../errors.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import type { WireClosure } from "./closure.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";
import { readShareClosure } from "./read-closure.js";

/** Every sha the closure would hand an audience, in one comparable set. */
function shasOf(closure: WireClosure): string[] {
  return closure.blobs.map((blob) => blob.sha256).toSorted();
}

function contentTitles(closure: WireClosure): string[] {
  return closure.rows.contentItems.map((row) => row.title ?? "").toSorted();
}

describe("[law:share-closure-confinement] a closure carries the named items' reach and nothing else", () => {
  afterEach(closeOpenVaults);

  test("[law:share-closure-confinement] a sibling item in the same library never crosses", () => {
    const { origin, originBoot } = household();
    const shared = seedPhoto(origin, originBoot, "shared");
    const withheld = seedPhoto(origin, originBoot, "withheld");
    const alsoWithheld = seedPhoto(origin, originBoot, "also-withheld");

    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "media.asset",
      itemIds: [shared.assetId],
    });

    expect(closure.rows.mediaAssets.map((row) => row.asset_id)).toStrictEqual([
      shared.assetId,
    ]);
    expect(contentTitles(closure)).toStrictEqual(["Photo shared"]);
    expect(closure.rows.derivatives.map((row) => row.content_id)).toStrictEqual(
      [shared.contentId]
    );
    // The bytes are the part that cannot be taken back once handed over: the
    // manifest names this photograph's original and thumb, and no other's.
    expect(shasOf(closure)).toStrictEqual(
      [shared.sha256, shared.thumbSha].toSorted()
    );
    for (const other of [withheld, alsoWithheld]) {
      expect(shasOf(closure)).not.toContain(other.sha256);
      expect(shasOf(closure)).not.toContain(other.thumbSha);
    }
    // Nothing else in the vault rode along on an unrelated table either.
    expect(closure.rows.documents).toStrictEqual([]);
    expect(closure.rows.collections).toStrictEqual([]);
    expect(closure.rows.docsFolders).toStrictEqual([]);
    expect(closure.rows.lockerItems).toStrictEqual([]);
    expect(closure.rows.tallyGroups).toStrictEqual([]);
  });

  test("[law:share-closure-confinement] an album carries its own entries, not a sibling album's", () => {
    const { origin, originBoot } = household();
    const inside = seedPhoto(origin, originBoot, "inside");
    const outside = seedPhoto(origin, originBoot, "outside");
    const now = nowIso();
    const write = origin.vault.prepare(
      `INSERT INTO core_collection
         (collection_id, owner_party_id, name, cover_content_id,
          parent_collection_id, sort_order, created_at)
       VALUES (?, ?, ?, NULL, NULL, 0, ?)`
    );
    const add = origin.vault.prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.asset', ?, 0, ?)`
    );
    const shared = uuidv7();
    const sibling = uuidv7();
    write.run(shared, originBoot.ownerPartyId, "Shared album", now);
    write.run(sibling, originBoot.ownerPartyId, "Private album", now);
    add.run(uuidv7(), shared, inside.assetId, now);
    add.run(uuidv7(), sibling, outside.assetId, now);

    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "core.collection",
      itemIds: [shared],
    });

    expect(
      closure.rows.collections.map((entry) => entry.row.collection_id)
    ).toStrictEqual([shared]);
    expect(closure.rows.mediaAssets.map((row) => row.asset_id)).toStrictEqual([
      inside.assetId,
    ]);
    expect(contentTitles(closure)).toStrictEqual(["Photo inside"]);
    expect(shasOf(closure)).toStrictEqual(
      [inside.sha256, inside.thumbSha].toSorted()
    );
  });

  test("[law:share-closure-confinement] a Docs folder carries its subtree, not a sibling folder's documents", () => {
    const { origin, originBoot } = household();
    const gateway = createGateway(origin);
    registerDocumentCommands(gateway);
    const owner: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const invoke = (command: string, input: Record<string, unknown>) => {
      const outcome = gateway.invoke(owner, {
        command,
        input,
        purpose: "dpv:ServiceProvision",
      });
      expect(outcome.status).toBe("executed");
      return (outcome as { output: Record<string, string> }).output;
    };
    const trip = invoke("core.create_folder", { name: "Trip" }).folder_id!;
    const nested = invoke("core.create_folder", {
      name: "Bookings",
      parent_folder_id: trip,
    }).folder_id!;
    const taxes = invoke("core.create_folder", { name: "Taxes" }).folder_id!;
    invoke("core.add_document", {
      folder_id: nested,
      title: "Train tickets",
      data_uri: "data:text/plain,tickets",
    });
    invoke("core.add_document", {
      folder_id: taxes,
      title: "Salary slip",
      data_uri: "data:text/plain,salary",
    });

    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "docs.folder",
      itemIds: [trip],
    });

    const folder = closure.rows.docsFolders[0]!;
    expect(folder.folders.map((row) => row.pref_label)).toStrictEqual([
      "Trip",
      "Bookings",
    ]);
    // The sibling folder's document is one join away and must stay behind.
    expect(closure.rows.documents.map((row) => row.title)).toStrictEqual([
      "Train tickets",
    ]);
    // …and so must its body: one content item crossed, the salary slip's did
    // not.
    expect(contentTitles(closure)).toStrictEqual(["Train tickets"]);
  });

  test("[law:share-closure-confinement] one unknown id refuses the whole read — no partial closure escapes", () => {
    const { origin, originBoot } = household();
    const known = seedPhoto(origin, originBoot, "known");
    const stranger = uuidv7();

    expect(() =>
      readShareClosure(origin.vault, {
        originVaultId: "vault-priya",
        itemType: "media.asset",
        itemIds: [known.assetId, stranger],
      })
    ).toThrow(VaultShareError);
    // A refusal that had returned what it managed to read would be a share the
    // owner never authorised — a smaller one, but a share.
    expect(() =>
      readShareClosure(origin.vault, {
        originVaultId: "vault-priya",
        itemType: "media.asset",
        itemIds: [known.assetId, stranger],
      })
    ).toThrow(`media.asset ${stranger} is not in the origin vault`);
  });

  test("[law:share-closure-confinement] an album entry of a type that cannot cross refuses the album", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "mixed");
    const now = nowIso();
    const collectionId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_collection
           (collection_id, owner_party_id, name, cover_content_id,
            parent_collection_id, sort_order, created_at)
         VALUES (?, ?, 'Mixed', NULL, NULL, 0, ?)`
      )
      .run(collectionId, originBoot.ownerPartyId, now);
    const add = origin.vault.prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    add.run(uuidv7(), collectionId, "media.asset", photo.assetId, 0, now);
    add.run(uuidv7(), collectionId, "core.person", uuidv7(), 1, now);

    expect(() =>
      readShareClosure(origin.vault, {
        originVaultId: "vault-priya",
        itemType: "core.collection",
        itemIds: [collectionId],
      })
    ).toThrow(
      "collection entry type core.person cannot cross a vault boundary"
    );
  });
});
