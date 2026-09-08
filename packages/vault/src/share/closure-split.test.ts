// The closure split (#726): an origin-side READ that writes nothing and
// serialises, and an audience-side PROJECTION that is the vault's own ingest
// door. What is pinned here is the three claims the split is FOR — one closure
// covers a set of items, a projected row is re-registered rather than
// inheriting the origin's derived state, and the wire path is the same code as
// the in-process one.

import { mkdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { plainSqliteRows } from "@centraid/test-kit/sqlite";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  closeOpenVaults,
  household,
  placementAuthority,
  seedPhoto,
} from "./placement-fixture.js";
import { shareItemsToVault } from "./placement.js";
import { projectShareClosure } from "./project-closure.js";
import { readShareClosure } from "./read-closure.js";

const extra: VaultDb[] = [];

/** A second audience vault beside the fixture's, for A/B projection. */
function secondAudience(root: string): VaultDb {
  const dir = path.join(root, "vaults", "family-b");
  mkdirSync(dir, { recursive: true });
  const db = openVaultDb({ dir });
  bootstrapVault(db, { ownerName: "Family B", vaultId: "vault-family-b" });
  extra.push(db);
  return db;
}

function rowsOf(db: VaultDb, sql: string): unknown[] {
  return plainSqliteRows(db.vault.prepare(sql).all());
}

describe("closure split", () => {
  afterEach(() => {
    while (extra.length > 0) extra.pop()?.close();
    closeOpenVaults();
  });

  test("one closure covers a SET of items, pooling the rows they share", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "pooled");
    const now = nowIso();
    // Two documents over the SAME content item — the case that proves pooling
    // is by row identity, not by item: three photographs with distinct bytes
    // would dedupe nothing.
    const first = uuidv7();
    const second = uuidv7();
    const write = origin.vault.prepare(
      `INSERT INTO core_document
         (document_id, title, current_content_id, created_at, updated_at,
          deleted_at, purge_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    );
    write.run(first, "Plan", photo.contentId, now, now);
    write.run(second, "Plan (copy)", photo.contentId, now, now);

    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "core.document",
      itemIds: [first, second, first],
    });

    // A repeated id is one item; the shared content item and its thumb cross
    // once each, and so do their bytes.
    expect(closure.items.map((item) => item.itemId)).toStrictEqual([
      first,
      second,
    ]);
    expect(closure.rows.contentItems).toHaveLength(1);
    expect(closure.rows.derivatives).toHaveLength(1);
    expect(closure.blobs.map((blob) => blob.rung).toSorted()).toStrictEqual([
      "original",
      "thumb",
    ]);

    const shared = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "core.document",
      itemIds: [first, second],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "core.document", [first, second]),
    });

    expect(shared.items.map((item) => item.itemId)).toStrictEqual([
      first,
      second,
    ]);
    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM core_content_item")
    ).toStrictEqual([{ n: 1 }]);
    expect(
      rowsOf(
        audience,
        "SELECT DISTINCT current_content_id AS id FROM core_document"
      )
    ).toStrictEqual([{ id: photo.contentId }]);
  });

  test("three photographs cross as ONE closure, one transaction, one lineage row each", () => {
    const { origin, originBoot, audience } = household();
    const photos = ["m1", "m2", "m3"].map((label) =>
      seedPhoto(origin, originBoot, label)
    );

    const shared = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: photos.map((photo) => photo.assetId),
      sharedBy: "member-priya",
      authority: placementAuthority(
        origin,
        "media.asset",
        photos.map((photo) => photo.assetId)
      ),
      now: () => 1_700_000_000_000,
    });

    expect(shared.items.map((item) => item.itemId)).toStrictEqual(
      photos.map((photo) => photo.assetId)
    );
    expect(shared.blobs).toHaveLength(6);
    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM media_asset")
    ).toStrictEqual([{ n: 3 }]);
    // A PLACEMENT CLAIMS NOTHING (#929): it is a move between the owner's own
    // vaults, so no shape claims the rows and none is owed one.
    expect(shared.items).toHaveLength(3);
    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM share_subscription_lineage")
    ).toStrictEqual([{ n: 0 }]);
  });

  test("a projected photograph is re-registered by the audience, not handed the origin's derived state", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "gps");
    const now = nowIso();
    // The origin's own derived state: a place it filed the photo under, and a
    // caption an enricher wrote about it.
    const originPlaceId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_place
           (place_id, name, kind, geo_lat, geo_lng, geohash, address_json, tz,
            parent_place_id, created_at)
         VALUES (?, 'Home', NULL, 12.9716, 77.5946, NULL, NULL, NULL, NULL, ?)`
      )
      .run(originPlaceId, now);
    origin.vault
      .prepare(
        `UPDATE media_asset SET place_id = ?, exif_json = ?
          WHERE asset_id = ?`
      )
      .run(
        originPlaceId,
        JSON.stringify({ latitude: 12.9716, longitude: 77.5946, width: 800 }),
        photo.assetId
      );
    origin.vault
      .prepare(
        `INSERT INTO knowledge_annotation
           (annotation_id, author_party_id, target_type, target_id,
            selector_json, body_text, created_at)
         VALUES (?, ?, 'media.asset', ?, NULL, 'a dog on a beach', ?)`
      )
      .run(uuidv7(), originBoot.ownerPartyId, photo.assetId, now);

    const shared = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
      now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    });

    // The place is RE-DERIVED from the camera's own testimony, under the
    // audience's ontology — never the origin's place id.
    const projectedPlace = audience.vault
      .prepare(
        `SELECT p.place_id, p.name, p.geo_lat FROM media_asset a
           JOIN core_place p ON p.place_id = a.place_id
          WHERE a.asset_id = ?`
      )
      .get(shared.items[0]!.itemId) as {
      place_id: string;
      name: string;
      geo_lat: number;
    };
    expect(projectedPlace.place_id).not.toBe(originPlaceId);
    expect(projectedPlace.name).toBe("12.9716, 77.5946");
    expect(projectedPlace.geo_lat).toBeCloseTo(12.9716, 4);

    // The enrichment the audience cannot inherit is ASKED for, in its own
    // queue, tagged as having arrived by projection.
    expect(
      rowsOf(
        audience,
        `SELECT target_id, reason, contribution_variant, required_capability,
                capability, requested_at, drained_at
           FROM enrich_request`
      )
    ).toStrictEqual([
      {
        target_id: shared.items[0]!.itemId,
        reason: "projected",
        contribution_variant: "embedding",
        required_capability: null,
        capability: null,
        requested_at: "2026-08-08T00:00:00.000Z",
        drained_at: null,
      },
    ]);

    // The owner's curation of their own library stayed there.
    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM knowledge_annotation")
    ).toStrictEqual([{ n: 0 }]);
    // Re-sharing is idempotent all the way through the door: a deduped row is
    // already registered, so it is not re-queued.
    shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-sid",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
    });
    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM enrich_request")
    ).toStrictEqual([{ n: 1 }]);
    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM core_place")
    ).toStrictEqual([{ n: 1 }]);
  });

  test("an audience whose media policy is strip gets no place from a share", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "strip");
    origin.vault
      .prepare("UPDATE media_asset SET exif_json = ? WHERE asset_id = ?")
      .run(
        JSON.stringify({ latitude: 12.9716, longitude: 77.5946 }),
        photo.assetId
      );
    audience.vault
      .prepare("UPDATE core_vault SET settings_json = ?")
      .run(JSON.stringify({ media: { location: "strip" } }));

    const shared = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
    });

    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM core_place")
    ).toStrictEqual([{ n: 0 }]);
    expect(
      audience.vault
        .prepare("SELECT place_id FROM media_asset WHERE asset_id = ?")
        .get(shared.items[0]!.itemId)
    ).toMatchObject({ place_id: null });
  });

  test("the wire path is the in-process path: JSON round-trip projects identically", () => {
    const { root, origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "wire");
    const other = secondAudience(root);
    const at = () => 1_700_000_000_000;

    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "media.asset",
      itemIds: [photo.assetId],
    });
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- the point of this test IS the JSON wire path; structuredClone doesn't serialize the same way and would test something else
    const wire = JSON.parse(JSON.stringify(closure)) as typeof closure;
    // Plain JSON: nothing in the closure is a Buffer, a Date, an undefined or
    // a class instance, so the round-trip changes no value. `toEqual`, not
    // `toStrictEqual`, because the driver hands back rows on its own prototype
    // and JSON normalises that — a difference of provenance, not of data.
    // oxlint-disable-next-line vitest/prefer-strict-equal -- see comment above: toStrictEqual fails on prototype provenance, not on data
    expect(wire).toEqual(closure);

    const shape = {
      shapeId: "shape-priya",
      rowVersions: new Map<string, number>(),
    };
    const inProcess = projectShareClosure(audience.vault, closure, {
      shape,
      now: at,
    });
    const overWire = projectShareClosure(other.vault, wire, {
      shape,
      now: at,
    });

    expect(overWire).toStrictEqual(inProcess);
    // `updated_at` is a LOCAL fact (#916, ruling ONT-08): the projector writes
    // the origin's columns and the receiving vault stamps when the row landed
    // in IT. Two separately-projected vaults are stamped microseconds apart,
    // and that difference is the column doing its job — the claim under test
    // is that the wire path projects the same CONTENT as the in-process one.
    for (const sql of [
      "SELECT content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at FROM core_content_item",
      "SELECT derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at FROM core_content_derivative",
      "SELECT asset_id, content_id, kind, captured_at, tz_offset_min, capture_group_id, place_id, camera_device_id, width, height, duration_s, exif_json, source_asset_id, archived_at, deleted_at, purge_at FROM media_asset",
      `SELECT shape_id, target_type, target_id, origin_item_id, origin_row_version
         FROM share_subscription_lineage ORDER BY target_type, target_id`,
      `SELECT target_type, target_id, reason, contribution_variant, requested_at
         FROM enrich_request`,
    ]) {
      expect(rowsOf(other, sql), sql).toStrictEqual(rowsOf(audience, sql));
    }
  });

  test("a closure from an unknown format version is refused, never half-projected", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "format");
    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "media.asset",
      itemIds: [photo.assetId],
    });

    expect(() =>
      projectShareClosure(
        audience.vault,
        { ...closure, formatVersion: 3 as unknown as 2 },
        { shape: { shapeId: "shape-priya", rowVersions: new Map() } }
      )
    ).toThrow(/unsupported share closure format/u);
    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM core_content_item")
    ).toStrictEqual([{ n: 0 }]);
  });

  // #916, audit F1. Entity ids are ONE namespace, and the ids on the wire are
  // PEER-CONTROLLED: an id the audience already holds as a place is not free
  // for an incoming asset just because `media_asset` has no row under it. The
  // membership trigger refuses the cross-kind collision outright, so `freeId`
  // has to ask `core_entity` — asking only the destination table left the
  // projection to abort mid-closure on a share that is perfectly legal.
  test("an id the audience holds under ANOTHER kind is minted fresh, not reused", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "collision");
    // The audience's own, unrelated place — filed under the id the origin's
    // asset happens to carry.
    audience.vault
      .prepare(
        `INSERT INTO core_place (place_id, name, created_at) VALUES (?, 'Beach', ?)`
      )
      .run(photo.assetId, nowIso());

    const shared = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "media.asset", [photo.assetId]),
    });

    const projectedId = shared.items[0]!.itemId;
    expect(projectedId).not.toBe(photo.assetId);
    // The place is untouched, and still the only holder of that entity id.
    expect(
      rowsOf(
        audience,
        `SELECT entity_type FROM core_entity WHERE entity_id = '${photo.assetId}'`
      )
    ).toStrictEqual([{ entity_type: "core.place" }]);
    expect(
      rowsOf(audience, "SELECT COUNT(*) AS n FROM core_place")
    ).toStrictEqual([{ n: 1 }]);
    // ...and the asset really landed, under its own id.
    expect(
      rowsOf(
        audience,
        `SELECT entity_type FROM core_entity WHERE entity_id = '${projectedId}'`
      )
    ).toStrictEqual([{ entity_type: "media.asset" }]);
  });

  test("an empty item set is refused before anything is read", () => {
    const { origin } = household();
    expect(() =>
      readShareClosure(origin.vault, {
        originVaultId: "vault-priya",
        itemType: "media.asset",
        itemIds: [],
      })
    ).toThrow(/at least one item/u);
  });
});
