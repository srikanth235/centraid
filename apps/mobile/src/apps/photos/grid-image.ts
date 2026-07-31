// What a photo-grid cell asks expo-image for, in one place.
//
// A grid cell is 80–160pt wide but its source is a full-resolution capture —
// tens of megapixels for a modern phone. Decoding that at full size to draw it
// into a thumbnail is the single largest allocation the Photos cover makes.
//
// Every prop here was checked against the installed expo-image (57.x,
// `node_modules/expo-image/build/Image.types.d.ts`); nothing is aspirational:
//
// - `allowDownscaling` (default `true`) is what makes the native side ask for
//   container-sized pixels rather than the whole asset. On iOS it sets
//   `imageThumbnailPixelSize` and, for `ph://` sources, the `targetSize` passed
//   to `PHImageManager.requestImage` (see `ios/ImageView.swift` and
//   `ios/Loaders/PhotoLibraryAssetLoader.swift`); on Android it drives Glide's
//   downsample strategy. It is pinned explicitly rather than left to the
//   default so a future prop sweep cannot silently put grid decode back to
//   full resolution.
// - `contentFit` must not be `none` or `fill` — expo-image skips downscaling
//   entirely for those two, which is why `cover` is part of this contract and
//   not a per-call-site choice.
// - `decodeFormat: "rgb"` decodes into RGB_565 instead of ARGB_8888, halving
//   the bytes a grid thumbnail holds. Grid cells are opaque (they letterbox
//   with `cover`), so the dropped alpha channel is not observable. Android-only
//   in expo-image; harmless elsewhere.
// - `priority: "low"` keeps a fast scroll from starving the lightbox, which
//   asks for the same pipeline at `normal`.
//
// expo-image 57 exposes no per-source pixel cap for a rendered `<Image>` — the
// only `maxWidth`/`maxHeight` knobs are on `useImage`/`loadAsync`, which are for
// imperatively loaded `ImageRef`s and would give up recycling. `ImageSource`'s
// `width`/`height` are layout defaults, not decode hints, so they are not used
// here.

import type { ImageProps } from "expo-image";

/** URI schemes that address bytes already on the device. */
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

/** True when the bytes live on this device rather than behind the gateway. */
export function isDeviceMediaUri(uri: string): boolean {
  return DEVICE_MEDIA_SCHEMES.some((scheme) => uri.startsWith(scheme));
}

/**
 * The decode/caching contract for one grid cell.
 *
 * The only axis that varies is the cache policy: writing a disk copy of a photo
 * the device already stores is pure duplication, so device-addressed sources
 * get `memory` while gateway-served thumbnails keep the disk tier that makes
 * them survive a relaunch offline.
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
