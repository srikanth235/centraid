import { describe, expect, test } from "vitest";

import { gridImageProps, isDeviceMediaUri } from "./grid-image";

describe("device media detection", () => {
  test("recognises every scheme the camera roll addresses photos with", () => {
    expect(isDeviceMediaUri("ph://ABC-123")).toBe(true);
    expect(isDeviceMediaUri("content://media/external/images/media/42")).toBe(
      true
    );
    expect(isDeviceMediaUri("file:///var/mobile/photo.jpg")).toBe(true);
    expect(isDeviceMediaUri("assets-library://asset/asset.JPG")).toBe(true);
  });

  test("a gateway URL is not device media", () => {
    expect(
      isDeviceMediaUri(
        "https://gateway.example/blobs/vault/content?variant=thumb"
      )
    ).toBe(false);
  });
});

describe("grid cell image props", () => {
  test("grid cells always ask for container-sized, low-priority pixels", () => {
    for (const uri of ["ph://ABC", "https://gateway.example/thumb"]) {
      expect(gridImageProps(uri)).toMatchObject({
        // Without this expo-image decodes the whole asset before scaling it
        // into a ~120pt cell.
        allowDownscaling: true,
        // Downscaling is skipped entirely for `none` and `fill`.
        contentFit: "cover",
        // RGB_565 rather than ARGB_8888 — half the bytes per thumbnail.
        decodeFormat: "rgb",
        priority: "low",
      });
    }
  });

  test("device-addressed bytes are never written to the disk cache", () => {
    // The photo is already on this device; a disk copy is pure duplication.
    expect(gridImageProps("ph://ABC").cachePolicy).toBe("memory");
    expect(gridImageProps("content://media/42").cachePolicy).toBe("memory");
  });

  test("gateway-served thumbnails keep the disk tier so they survive offline", () => {
    expect(gridImageProps("https://gateway.example/thumb").cachePolicy).toBe(
      "memory-disk"
    );
  });
});
