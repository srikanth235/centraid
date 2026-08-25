// The `media.location` policy at closure READ (#726 P3 decision 8,
// threat 8): a `strip` origin must not let GPS cross a CROSS-OWNER boundary
// through `exif_json`, even though `projection-ingest.ts` already stops the
// AUDIENCE from re-deriving a `place_id` from it — the coordinates themselves
// still rode the wire before that gate ever ran. Same-owner edges (the local
// placement plane) are the owner's own data moving between their own vaults,
// so they must see no redaction at all, regardless of the origin's policy.

import { afterEach, describe, expect, test } from "vitest";

import { updateBlobStoreSettings } from "../host.js";
import { household, seedPhoto, closeOpenVaults } from "./placement-fixture.js";
import { readShareClosure } from "./read-closure.js";

function withGps(
  vault: ReturnType<typeof household>["origin"],
  assetId: string
): void {
  vault.vault
    .prepare("UPDATE media_asset SET exif_json = ? WHERE asset_id = ?")
    .run(
      JSON.stringify({
        has_location: true,
        latitude: 12.9716,
        longitude: 77.5946,
        width: 800,
      }),
      assetId
    );
}

describe("media.location policy at closure read", () => {
  afterEach(() => {
    closeOpenVaults();
  });

  test("a strip origin redacts GPS from exif_json on a cross-owner read", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "gps");
    withGps(origin, photo.assetId);
    updateBlobStoreSettings(origin, { media_location: "strip" });

    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "media.asset",
      itemIds: [photo.assetId],
      crossOwner: true,
    });

    const asset = closure.rows.mediaAssets[0]!;
    const exif = JSON.parse(asset.exif_json!) as Record<string, unknown>;
    expect(exif.latitude).toBeUndefined();
    expect(exif.longitude).toBeUndefined();
    // A boolean fact, not a coordinate — survives exactly as ingest-time
    // stripping already leaves it (pipeline.ts).
    expect(exif.has_location).toBe(true);
    expect(exif.width).toBe(800);
  });

  test("a strip origin leaves exif_json untouched on a same-owner read", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "gps-same-owner");
    withGps(origin, photo.assetId);
    updateBlobStoreSettings(origin, { media_location: "strip" });

    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "media.asset",
      itemIds: [photo.assetId],
      // crossOwner omitted — same-owner default.
    });

    const asset = closure.rows.mediaAssets[0]!;
    const exif = JSON.parse(asset.exif_json!) as Record<string, unknown>;
    expect(exif.latitude).toBe(12.9716);
    expect(exif.longitude).toBe(77.5946);
  });

  test("a keep origin never redacts, cross-owner or not", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "gps-keep");
    withGps(origin, photo.assetId);
    // media.location defaults to 'keep' — no explicit patch needed.

    const closure = readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: "media.asset",
      itemIds: [photo.assetId],
      crossOwner: true,
    });

    const asset = closure.rows.mediaAssets[0]!;
    const exif = JSON.parse(asset.exif_json!) as Record<string, unknown>;
    expect(exif.latitude).toBe(12.9716);
    expect(exif.longitude).toBe(77.5946);
  });
});
