import { Directory, File, Paths } from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import * as VideoThumbnails from "expo-video-thumbnails";
import jpeg from "jpeg-js";
import { rgbaToThumbHash } from "thumbhash";

import { BLOB_MEDIUM_EDGE, BLOB_TINY_EDGE } from "@centraid/core/blob";

import { authHeader } from "../gateway";
import { bytesToBase64 } from "./bytes";

export type DeviceDerivativeVariant = "thumb" | "preview" | "poster";

/**
 * THE PHONE IS THE ONLY DECODER FOR HEIC (#1011). The gateway's preview codec
 * is sharp, and the `@img/sharp-libvips-darwin-arm64` this repo pins ships
 * libheif WITHOUT an HEVC decoder (patent licensing) — so the HEVC-coded HEIC
 * an iPhone actually writes DECLINES on the gateway and earns the durable
 * `preview-codec@1` "unsupported" stamp, after which every recognition recipe
 * skips it. iOS decodes it natively, so the phone contributes the JPEG display
 * rungs itself and the marker never stands.
 *
 * Keyed by EXTENSION because the import door is filename-routed: the phone
 * names the file before the gateway has sniffed a byte.
 */
const GATEWAY_UNDECODABLE_EXTENSIONS = new Set(["heic", "heif", "hif"]);

export function gatewayCanDecode(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return !GATEWAY_UNDECODABLE_EXTENSIONS.has(extension);
}

export interface SourceSize {
  width: number;
  height: number;
}

/**
 * The ladder's rungs FIT WITHIN `maxEdge` on the LONG side and NEVER UPSCALE —
 * the gateway contract in `packages/vault/src/blob/preview.ts`. ImageManipulator
 * preserves the aspect ratio from whichever single dimension it is given, so
 * naming the long one is the whole of the fit; `null` means the original is
 * already inside the box and is copied through untouched.
 */
export function longEdgeResize(
  source: SourceSize | undefined,
  maxEdge: number
): { width: number } | { height: number } | null {
  // Without dimensions the width is the only edge we can name; a portrait
  // original then lands slightly taller than the gateway's rung, which the
  // ladder tolerates (a rung is an accelerator, never a correctness input).
  if (!source) return { width: maxEdge };
  if (source.width <= 0 || source.height <= 0) return { width: maxEdge };
  if (Math.max(source.width, source.height) <= maxEdge) return null;
  return source.width >= source.height
    ? { width: maxEdge }
    : { height: maxEdge };
}

/** `poster` is not a ladder rung — no gateway backstop produces it — so its
 *  edge is ours to choose, unlike `thumb`/`preview` above. */
const POSTER_EDGE = 1_024;

/**
 * THUMBHASH CAPS AT 100×100 AND THROWS ABOVE IT (#1011). `rgbaToThumbHash`
 * raises `<w>x<h> doesn't fit in 100x100`, so hashing the decoded `thumb`
 * (long edge `BLOB_TINY_EDGE` = 256) threw for EVERY still — taking the whole
 * derivative set, and on the import path the phone's only HEIC display rungs,
 * down with it. The inline rungs get their OWN ≤100px render.
 *
 * The number mirrors the gateway's `THUMBHASH_EDGE`
 * (`packages/server/src/preview/codec.ts` and its two sibling codecs): both
 * sides downscale the long edge to 100 before hashing, so a phone thumbhash
 * and a gateway thumbhash of the same photograph agree.
 */
const THUMBHASH_EDGE = 100;

export interface DeviceDerivative {
  variant: DeviceDerivativeVariant;
  uri: string;
  mediaType: "image/jpeg";
}

export interface DeviceDerivativeSet {
  binary: DeviceDerivative[];
  thumbhash: string;
  phash: string;
}

/**
 * ImageManipulator writes rungs into the OS-trimmable cache. Their URIs are
 * persisted in the follow-up ledger and read back on replay — possibly days
 * later — so a cache trim between generation and contribution would throw
 * forever and starve the record (F3). Copy each rung into a durable directory
 * under the document root instead, and delete it once the follow-up settles.
 */
const DERIVATIVES_DIRNAME = "centraid-upload-derivatives";

function durableDerivativesDir(): Directory {
  const dir = new Directory(Paths.document, DERIVATIVES_DIRNAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** Copy a cache rung to durable storage and return its stable URI. */
function persistDurably(cacheUri: string, name: string): string {
  const destination = new File(durableDerivativesDir(), name);
  if (destination.exists) destination.delete();
  // expo-file-system 57 made `copy()` async and split the original synchronous
  // behaviour out as `copySync()`. This helper is sync by contract (its callers
  // build derivative descriptors inline), so it keeps the synchronous variant.
  new File(cacheUri).copySync(destination);
  return destination.uri;
}

async function jpegRung(
  uri: string,
  maxEdge: number,
  compress: number,
  source?: SourceSize
): Promise<string> {
  const resize = longEdgeResize(source, maxEdge);
  const result = await ImageManipulator.manipulateAsync(
    uri,
    resize ? [{ resize }] : [],
    {
      compress,
      format: ImageManipulator.SaveFormat.JPEG,
    }
  );
  return result.uri;
}

/**
 * 8×8 difference hash of a decoded thumbnail. Exported for unit coverage: pure
 * arithmetic over RGBA, no native dependency.
 */
export function dhash(width: number, height: number, data: Uint8Array): string {
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / 8));
    for (let x = 0; x < 8; x += 1) {
      const leftX = Math.min(width - 1, Math.floor((x * width) / 9));
      const rightX = Math.min(width - 1, Math.floor(((x + 1) * width) / 9));
      const left = (sy * width + leftX) * 4;
      const right = (sy * width + rightX) * 4;
      const a =
        data[left]! * 299 + data[left + 1]! * 587 + data[left + 2]! * 114;
      const b =
        data[right]! * 299 + data[right + 1]! * 587 + data[right + 2]! * 114;
      bits = (bits << 1n) | (a > b ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

/** HEIC/video-safe device derivatives: native decode first, tiny JPEG decode second. */
export async function generateDeviceDerivatives(
  localUri: string,
  mediaType: string,
  sourceSize?: SourceSize
): Promise<DeviceDerivativeSet> {
  const source = mediaType.startsWith("video/")
    ? (
        await VideoThumbnails.getThumbnailAsync(localUri, {
          time: 0,
          quality: 0.9,
        })
      ).uri
    : localUri;
  // The edges are the LADDER'S, imported rather than mirrored: a rung the
  // gateway would size differently is a rung two devices disagree about.
  const thumb = await jpegRung(source, BLOB_TINY_EDGE, 0.82, sourceSize);
  const preview = await jpegRung(source, BLOB_MEDIUM_EDGE, 0.86, sourceSize);
  const poster = mediaType.startsWith("video/")
    ? await jpegRung(source, POSTER_EDGE, 0.86, sourceSize)
    : undefined;
  // A THIRD, UNPERSISTED render, not the `thumb`: see `THUMBHASH_EDGE`. The
  // 8×8 difference hash reads the same raster, which costs nothing and keeps
  // one decode for both inline rungs.
  const hashSource = await jpegRung(source, THUMBHASH_EDGE, 0.9, sourceSize);
  const decoded = jpeg.decode(await new File(hashSource).bytes(), {
    useTArray: true,
  });
  const thumbhash = bytesToBase64(
    rgbaToThumbHash(decoded.width, decoded.height, decoded.data)
  ).replace(/=+$/u, "");
  // A per-set token keeps concurrent producers from colliding on durable names.
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    binary: [
      {
        variant: "thumb",
        uri: persistDurably(thumb, `${token}-thumb.jpg`),
        mediaType: "image/jpeg",
      },
      {
        variant: "preview",
        uri: persistDurably(preview, `${token}-preview.jpg`),
        mediaType: "image/jpeg",
      },
      ...(poster
        ? [
            {
              variant: "poster" as const,
              uri: persistDurably(poster, `${token}-poster.jpg`),
              mediaType: "image/jpeg" as const,
            },
          ]
        : []),
    ],
    thumbhash,
    phash: dhash(decoded.width, decoded.height, decoded.data),
  };
}

export async function contributeDeviceDerivatives(
  gatewayBase: string,
  parentSha: string,
  derivatives: readonly DeviceDerivative[]
): Promise<void> {
  await Promise.all(
    derivatives.map(async (derivative) => {
      const file = new File(derivative.uri);
      // Derivatives are gateway-regenerable accelerators, not correctness. If the
      // durable copy is somehow gone, skip it rather than throw — a thrown error
      // would poison the whole follow-up, including its canonical replica write.
      if (!file.exists) return;
      const params = new URLSearchParams({
        variant: derivative.variant,
        variant_of: parentSha,
        media_type: derivative.mediaType,
      });
      const response = await fetch(
        `${gatewayBase}/centraid/_vault/blobs?${params}`,
        {
          method: "POST",
          headers: { "content-type": derivative.mediaType, ...authHeader() },
          body: (await file.bytes()).buffer as ArrayBuffer,
        }
      );
      if (!response.ok)
        throw new Error(
          `Derivative ${derivative.variant} failed (${response.status})`
        );
    })
  );
}

/**
 * The INLINE rungs, through the same variant door (#419, #1011). The upload
 * QUEUE path hands these to `photos.upload` as command input; the IMPORT path
 * has no such field on `media.asset`, so it contributes them here — which the
 * ledger accepts identically, and which matters beyond the placeholder: with
 * `phash`/`thumbhash` still missing, `backfillPreviews` re-selects the item,
 * asks the codec that already declined it, and stamps it unsupported even
 * though the display rungs are sitting on the row.
 */
export async function contributeDeviceHashes(
  gatewayBase: string,
  parentSha: string,
  hashes: { phash: string; thumbhash: string }
): Promise<void> {
  const inline: readonly {
    variant: string;
    mediaType: string;
    value: string;
  }[] = [
    {
      variant: "phash",
      mediaType: "text/x-perceptual-hash",
      value: hashes.phash,
    },
    {
      variant: "thumbhash",
      mediaType: "application/x-thumbhash",
      value: hashes.thumbhash,
    },
  ];
  await Promise.all(
    inline.map(async (entry) => {
      const params = new URLSearchParams({
        variant: entry.variant,
        variant_of: parentSha,
        media_type: entry.mediaType,
      });
      const response = await fetch(
        `${gatewayBase}/centraid/_vault/blobs?${params}`,
        {
          method: "POST",
          headers: { "content-type": entry.mediaType, ...authHeader() },
          body: entry.value,
        }
      );
      if (!response.ok)
        throw new Error(
          `Derivative ${entry.variant} failed (${response.status})`
        );
    })
  );
}

/** Delete durable derivative copies once their follow-up has settled (F3/F10). */
export function cleanupDeviceDerivatives(
  derivatives: readonly DeviceDerivative[]
): void {
  for (const derivative of derivatives) {
    try {
      const file = new File(derivative.uri);
      if (file.exists) file.delete();
    } catch {
      // A leaked temp is a cosmetic loss, never a correctness one.
    }
  }
}
