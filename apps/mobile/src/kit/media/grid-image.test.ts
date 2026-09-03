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
        allowDownscaling: true,
        contentFit: "cover",
        decodeFormat: "rgb",
        priority: "low",
      });
    }
  });

  test("device-addressed bytes are never written to the disk cache", () => {
    expect(gridImageProps("ph://ABC").cachePolicy).toBe("memory");
    expect(gridImageProps("content://media/42").cachePolicy).toBe("memory");
  });

  test("gateway-served thumbnails keep the disk tier so they survive offline", () => {
    expect(gridImageProps("https://gateway.example/thumb").cachePolicy).toBe(
      "memory-disk"
    );
  });
});
