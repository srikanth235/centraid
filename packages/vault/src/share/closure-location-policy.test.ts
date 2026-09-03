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
