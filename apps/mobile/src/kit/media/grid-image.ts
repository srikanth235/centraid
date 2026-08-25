// Decode contract for one photo-grid cell (80–160pt, full-resolution source).
//
// Every prop exists on expo-image 57 `ImageProps`; nothing is aspirational:
//
// - `allowDownscaling` is pinned `true` so a prop sweep cannot silently decode
//   at full resolution. `none`/`fill` `contentFit` skip downscaling entirely,
//   which is why `cover` is part of this contract.
// - `decodeFormat: "rgb"` is RGB_565 (Android-only; harmless elsewhere). Grid
//   cells are opaque under `cover`, so dropped alpha is not observable.
// - `priority: "low"` keeps a fast scroll from starving the lightbox.
//
// expo-image 57 has no per-source pixel cap on a rendered `<Image>` —
// `maxWidth`/`maxHeight` live on `useImage`/`loadAsync` and would give up
// recycling. `ImageSource` width/height are layout defaults, not decode hints.

import type { ImageProps } from "expo-image";

const DEVICE_MEDIA_SCHEMES = [
  "ph://",
  "content://",
  "file://",
  "assets-library://",
];

export type GridImageProps = Required<
  Pick<
    ImageProps,
    | "allowDownscaling"
    | "cachePolicy"
    | "contentFit"
    | "decodeFormat"
    | "priority"
  >
>;

export function isDeviceMediaUri(uri: string): boolean {
  return DEVICE_MEDIA_SCHEMES.some((scheme) => uri.startsWith(scheme));
}

/**
 * The only axis that varies is cache policy: device-addressed sources get
 * `memory` (a disk copy of bytes already on device is duplication); gateway
 * thumbnails keep `memory-disk` so they survive a relaunch offline.
 */
export function gridImageProps(uri: string): GridImageProps {
  return {
    allowDownscaling: true,
    cachePolicy: isDeviceMediaUri(uri) ? "memory" : "memory-disk",
    contentFit: "cover",
    decodeFormat: "rgb",
    priority: "low",
  };
}
