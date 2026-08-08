import { pathToFileURL } from "node:url";

import { resolveRuntimeModule } from "./onnx.js";

// Same lazy-import seam as src/onnx.ts, for the same reason: sharp is a
// native-addon image codec, so it lives in runtime/package.json next to
// onnxruntime-node rather than in this workspace package's own
// dependencies. See src/onnx.ts's header comment for the full rationale.

// Minimal shape of the subset of the sharp API this file calls. sharp ships
// its own types, but — like onnxruntime-node — it is only ever resolvable
// from runtime/node_modules, never from this package's module graph, so we
// declare just what we use rather than depending on @types/sharp.
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
 * Decodes and resizes to an exact square `size` using center-crop (matches
 * the OpenAI CLIP preprocessing pipeline: resize shortest side then center
 * crop — sharp's `fit: "cover"` with center position performs both steps in
 * one pass), returning raw interleaved RGB.
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

/** Decodes and resizes to an exact `width`x`height`, distorting aspect ratio (used for detector inputs that expect a fixed grid). */
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

/**
 * Crops a decoded image to an integer-pixel region, clamping to the image's
 * own bounds. Pure buffer indexing — no sharp round-trip needed for a crop
 * of already-decoded raw RGB.
 */
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

/**
 * ImageNet normalization (mean/std below) used by PaddleOCR's det + rec
 * preprocessing: interleaved uint8 RGB -> planar float32 CHW, scaled to
 * [0,1] then normalized per channel.
 */
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export function normalizeImageNet(image: DecodedImage): Float32Array {
  const { width, height, data } = image;
  const planeSize = width * height;
  const out = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = (data[pixel * 3 + channel] ?? 0) / 255;
      // channel is always 0/1/2 (the inner loop bound above), so these
      // fixed 3-element tuples are always in range despite
      // noUncheckedIndexedAccess.
      out[channel * planeSize + pixel] =
        (value - (IMAGENET_MEAN[channel] as number)) /
        (IMAGENET_STD[channel] as number);
    }
  }
  return out;
}

/**
 * OpenCV `blobFromImage(image)` parity for YuNet: interleaved RGB bytes become
 * planar BGR float32 with no scale or mean. YuNet's pinned export performs its
 * own normalization and is materially wrong when fed ImageNet-normalized RGB.
 */
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

/**
 * CLIP normalization: interleaved uint8 RGB -> planar float32 CHW, scaled to
 * [0,1] then normalized with the published OpenAI CLIP per-channel
 * mean/std (see clip.py's `_transform`, MIT-licensed, same source as the
 * ViT-B/32 weights this service downloads — LICENSES.md).
 */
const CLIP_MEAN = [0.481_454_66, 0.457_827_5, 0.408_210_73] as const;
const CLIP_STD = [0.268_629_54, 0.261_302_58, 0.275_777_11] as const;

export function normalizeClip(image: DecodedImage): Float32Array {
  const { width, height, data } = image;
  const planeSize = width * height;
  const out = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = (data[pixel * 3 + channel] ?? 0) / 255;
      // channel is always 0/1/2 (the inner loop bound above), so these
      // fixed 3-element tuples are always in range despite
      // noUncheckedIndexedAccess.
      out[channel * planeSize + pixel] =
        (value - (CLIP_MEAN[channel] as number)) /
        (CLIP_STD[channel] as number);
    }
  }
  return out;
}
