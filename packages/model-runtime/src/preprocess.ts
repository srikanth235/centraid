import { pathToFileURL } from "node:url";

import { resolveRuntimeModule } from "./onnx.js";

// Lazy-import seam as in src/onnx.ts: sharp is a native addon, resolvable only
// from runtime/node_modules — so it lives in runtime/package.json and we
// declare just the subset we use instead of depending on @types/sharp.
export interface DecodedImage {
  /** Interleaved RGB, 8 bits per channel, no alpha. */
  data: Uint8Array;
  width: number;
  height: number;
}

interface SharpInstance {
  resize: (options: {
    width: number;
    height: number;
    fit: "cover" | "fill";
    position?: string;
  }) => SharpInstance;
  removeAlpha: () => SharpInstance;
  raw: () => SharpInstance;
  toBuffer: (options: { resolveWithObject: true }) => Promise<{
    data: Buffer;
    info: { width: number; height: number; channels: number };
  }>;
  metadata: () => Promise<{ width?: number; height?: number }>;
}

interface RawInputOptions {
  raw: { width: number; height: number; channels: number };
}

type SharpFactory = (input: Buffer, options?: RawInputOptions) => SharpInstance;

let cachedSharp: SharpFactory | undefined;

async function loadSharp(): Promise<SharpFactory> {
  if (cachedSharp) {
    return cachedSharp;
  }
  const resolved = resolveRuntimeModule("sharp");
  const mod = (await import(pathToFileURL(resolved).href)) as {
    default: SharpFactory;
  };
  cachedSharp = mod.default;
  return cachedSharp;
}

/** Test-only seam. @public */
export function resetSharpCacheForTests(): void {
  cachedSharp = undefined;
}

/** Decodes arbitrary image bytes to raw interleaved RGB, native resolution. */
export async function decodeImage(bytes: Uint8Array): Promise<DecodedImage> {
  const sharp = await loadSharp();
  const image = sharp(Buffer.from(bytes));
  const { data, info } = await image
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/**
 * Exact-square resize with center-crop (OpenAI CLIP preprocessing: sharp's
 * `fit: "cover"` does shortest-side-resize + center-crop in one pass),
 * returning raw interleaved RGB.
 */
export async function decodeImageCenterCropped(
  bytes: Uint8Array,
  size: number
): Promise<DecodedImage> {
  const sharp = await loadSharp();
  const image = sharp(Buffer.from(bytes));
  const { data, info } = await image
    .resize({ width: size, height: size, fit: "cover", position: "centre" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** Exact width×height resize, distorting aspect (fixed-grid detector inputs). */
export async function decodeImageResized(
  bytes: Uint8Array,
  width: number,
  height: number
): Promise<DecodedImage> {
  const sharp = await loadSharp();
  const image = sharp(Buffer.from(bytes));
  const { data, info } = await image
    .resize({ width, height, fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** Crop to an integer-pixel region, clamped to image bounds. Pure buffer
 *  indexing — no sharp round-trip for already-decoded raw RGB. */
export function cropImage(
  image: DecodedImage,
  region: { x: number; y: number; width: number; height: number }
): DecodedImage {
  const x0 = Math.max(0, Math.min(image.width, Math.round(region.x)));
  const y0 = Math.max(0, Math.min(image.height, Math.round(region.y)));
  const x1 = Math.max(
    x0,
    Math.min(image.width, Math.round(region.x + region.width))
  );
  const y1 = Math.max(
    y0,
    Math.min(image.height, Math.round(region.y + region.height))
  );
  const width = x1 - x0;
  const height = y1 - y0;

  const out = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const srcStart = ((y0 + row) * image.width + x0) * 3;
    const dstStart = row * width * 3;
    out.set(image.data.subarray(srcStart, srcStart + width * 3), dstStart);
  }
  return { data: out, width, height };
}

/** Resizes an already-decoded raw RGB image to an exact width/height via sharp's raw-input mode. */
export async function resizeDecodedImage(
  image: DecodedImage,
  targetWidth: number,
  targetHeight: number
): Promise<DecodedImage> {
  const sharp = await loadSharp();
  const raw = sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 3 },
  });
  const { data, info } = await raw
    .resize({ width: targetWidth, height: targetHeight, fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** ImageNet normalization for PaddleOCR det+rec: uint8 RGB -> planar CHW. */
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export function normalizeImageNet(image: DecodedImage): Float32Array {
  const { width, height, data } = image;
  const planeSize = width * height;
  const out = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = (data[pixel * 3 + channel] ?? 0) / 255;
      // channel < 3 by loop bound, so the tuples are always in range.
      out[channel * planeSize + pixel] =
        (value - (IMAGENET_MEAN[channel] as number)) /
        (IMAGENET_STD[channel] as number);
    }
  }
  return out;
}

/** OpenCV blobFromImage parity for YuNet: RGB bytes -> planar BGR float32,
 *  no scale/mean — YuNet normalizes itself; ImageNet-normalized input breaks it. */
export function toOpenCvBgrPlanar(image: DecodedImage): Float32Array {
  const { width, height, data } = image;
  const planeSize = width * height;
  const out = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel++) {
    out[pixel] = data[pixel * 3 + 2] ?? 0;
    out[planeSize + pixel] = data[pixel * 3 + 1] ?? 0;
    out[planeSize * 2 + pixel] = data[pixel * 3] ?? 0;
  }
  return out;
}

/** Unscaled planar RGB used by OpenCV SFace's `blobFromImage(..., swapRB=true)`. */
export function toOpenCvRgbPlanar(image: DecodedImage): Float32Array {
  const { width, height, data } = image;
  const planeSize = width * height;
  const out = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel++) {
    out[pixel] = data[pixel * 3] ?? 0;
    out[planeSize + pixel] = data[pixel * 3 + 1] ?? 0;
    out[planeSize * 2 + pixel] = data[pixel * 3 + 2] ?? 0;
  }
  return out;
}

/** CLIP normalization: uint8 RGB -> planar CHW with published OpenAI CLIP
 *  mean/std (clip.py _transform, MIT — same source as our ViT-B/32 weights). */
const CLIP_MEAN = [0.481_454_66, 0.457_827_5, 0.408_210_73] as const;
const CLIP_STD = [0.268_629_54, 0.261_302_58, 0.275_777_11] as const;

export function normalizeClip(image: DecodedImage): Float32Array {
  const { width, height, data } = image;
  const planeSize = width * height;
  const out = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = (data[pixel * 3 + channel] ?? 0) / 255;
      // channel < 3 by loop bound, so the tuples are always in range.
      out[channel * planeSize + pixel] =
        (value - (CLIP_MEAN[channel] as number)) /
        (CLIP_STD[channel] as number);
    }
  }
  return out;
}
