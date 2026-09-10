import sharp from "sharp";

import type { PreviewCodec, PreviewOutput } from "@centraid/vault";

import { rgbaToThumbHash } from "./thumbhash.js";

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_EDGE = 12_000;
const THUMBHASH_EDGE = 100;

/**
 * What libvips decodes for us. HEIC/HEIF is here because iPhones capture it by
 * DEFAULT: without it most of a real phone library would carry no preview rung
 * at all, and every recognition recipe would read "not ready" forever (#1011).
 * The PORTABLE codec cannot decode HEIC — jpeg-js and pngjs are its whole
 * decoder set — so a HEIC preview requires this native codec to have loaded.
 * A source libheif refuses (the simulator's stock camera-roll HEIC trips its
 * iref-reference security limit) is a DECLINE, not a crash: every entry point
 * below catches and returns `null`, exactly as a corrupt JPEG does.
 */
const SUPPORTED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

function supported(mediaType: string): boolean {
  return SUPPORTED_MEDIA_TYPES.has(mediaType.toLowerCase());
}

function input(source: Buffer) {
  return sharp(source, {
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  }).rotate();
}

async function dimensionsAllowed(source: Buffer): Promise<boolean> {
  const metadata = await input(source).metadata();
  return (
    typeof metadata.width === "number" &&
    typeof metadata.height === "number" &&
    metadata.width <= MAX_INPUT_EDGE &&
    metadata.height <= MAX_INPUT_EDGE &&
    metadata.width * metadata.height <= MAX_INPUT_PIXELS
  );
}

/** Native libvips codec: decode, resize and encode all run off the JS thread. */
export function createNativeImagePreviewCodec(): PreviewCodec {
  return {
    async downscale(
      source: Buffer,
      mediaType: string,
      maxEdge: number
    ): Promise<PreviewOutput | null> {
      if (!supported(mediaType)) return null;
      try {
        if (!(await dimensionsAllowed(source))) return null;
        const { data, info } = await input(source)
          .resize({
            width: maxEdge,
            height: maxEdge,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 80, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        return {
          bytes: data,
          mediaType: "image/jpeg",
          width: info.width,
          height: info.height,
        };
      } catch {
        return null;
      }
    },

    async perceptualHash(
      source: Buffer,
      mediaType: string
    ): Promise<string | null> {
      if (!supported(mediaType)) return null;
      try {
        if (!(await dimensionsAllowed(source))) return null;
        const pixels = await input(source)
          .greyscale()
          .resize(9, 8, { fit: "fill" })
          .raw()
          .toBuffer();
        let hash = 0n;
        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            hash =
              (hash << 1n) |
              (pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1n : 0n);
          }
        }
        return hash.toString(16).padStart(16, "0");
      } catch {
        return null;
      }
    },

    async thumbhash(source: Buffer, mediaType: string): Promise<string | null> {
      if (!supported(mediaType)) return null;
      try {
        if (!(await dimensionsAllowed(source))) return null;
        const { data, info } = await input(source)
          .resize({
            width: THUMBHASH_EDGE,
            height: THUMBHASH_EDGE,
            fit: "inside",
            withoutEnlargement: true,
          })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const bytes = rgbaToThumbHash(
          info.width,
          info.height,
          new Uint8Array(data)
        );
        return Buffer.from(bytes).toString("base64").replace(/=+$/u, "");
      } catch {
        return null;
      }
    },
  };
}
