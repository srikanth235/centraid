import { createRequire } from 'node:module';
import type { PreviewCodec, PreviewOutput } from '@centraid/vault';
import { rgbaToThumbHash } from './thumbhash.js';

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_EDGE = 12_000;
const THUMBHASH_EDGE = 100;

interface VipsImage {
  readonly width: number;
  readonly height: number;
  autorot(): VipsImage;
  resize(scale: number, options?: { vscale?: number }): VipsImage;
  copy(): VipsImage;
  hasAlpha(): boolean;
  flatten(options?: { background?: number[] }): VipsImage;
  colourspace(space: string): VipsImage;
  cast(format: string): VipsImage;
  addalpha(): VipsImage;
  writeToBuffer(format: string): Uint8Array;
  writeToMemory(): Uint8Array;
  delete(): void;
}

interface VipsRuntime {
  Image: { newFromBuffer(source: Uint8Array): VipsImage };
}

// Avoid pulling wasm-vips' 260 KiB generated operation declaration into every
// gateway typecheck; this narrow seam is the only API surface the codec uses.
const require = createRequire(import.meta.url);
const Vips = require('wasm-vips') as () => Promise<VipsRuntime>;

let runtime: Promise<VipsRuntime> | undefined;

function getRuntime(): Promise<VipsRuntime> {
  runtime ??= Vips();
  return runtime;
}

function supported(mediaType: string): boolean {
  return mediaType === 'image/jpeg' || mediaType === 'image/png';
}

function allowed(image: VipsImage): boolean {
  return (
    image.width > 0 &&
    image.height > 0 &&
    image.width <= MAX_INPUT_EDGE &&
    image.height <= MAX_INPUT_EDGE &&
    image.width * image.height <= MAX_INPUT_PIXELS
  );
}

function dispose(images: VipsImage[]): void {
  const seen = new Set<VipsImage>();
  for (const image of images.toReversed()) {
    if (seen.has(image)) continue;
    seen.add(image);
    image.delete();
  }
}

/** Electron codec: libvips compiled to WebAssembly, with no native-addon ABI coupling. */
export function createWasmImagePreviewCodec(): PreviewCodec {
  return {
    async downscale(
      source: Buffer,
      mediaType: string,
      maxEdge: number,
    ): Promise<PreviewOutput | null> {
      if (!supported(mediaType)) return null;
      const images: VipsImage[] = [];
      try {
        const vips = await getRuntime();
        const decoded = vips.Image.newFromBuffer(source);
        images.push(decoded);
        const upright = decoded.autorot();
        images.push(upright);
        if (!allowed(upright)) return null;
        const scale = Math.min(1, maxEdge / Math.max(upright.width, upright.height));
        const resized = scale < 1 ? upright.resize(scale) : upright.copy();
        images.push(resized);
        const opaque = resized.hasAlpha()
          ? resized.flatten({ background: [255, 255, 255] })
          : resized;
        images.push(opaque);
        return {
          bytes: Buffer.from(opaque.writeToBuffer('.jpg[Q=80,strip]')),
          mediaType: 'image/jpeg',
          width: opaque.width,
          height: opaque.height,
        };
      } catch {
        return null;
      } finally {
        dispose(images);
      }
    },

    async perceptualHash(source: Buffer, mediaType: string): Promise<string | null> {
      if (!supported(mediaType)) return null;
      const images: VipsImage[] = [];
      try {
        const vips = await getRuntime();
        const decoded = vips.Image.newFromBuffer(source);
        images.push(decoded);
        const upright = decoded.autorot();
        images.push(upright);
        if (!allowed(upright)) return null;
        const sampled = upright
          .resize(9 / upright.width, { vscale: 8 / upright.height })
          .colourspace('b-w')
          .cast('uchar');
        images.push(sampled);
        const pixels = sampled.writeToMemory();
        let hash = 0n;
        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            hash = (hash << 1n) | (pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1n : 0n);
          }
        }
        return hash.toString(16).padStart(16, '0');
      } catch {
        return null;
      } finally {
        dispose(images);
      }
    },

    async thumbhash(source: Buffer, mediaType: string): Promise<string | null> {
      if (!supported(mediaType)) return null;
      const images: VipsImage[] = [];
      try {
        const vips = await getRuntime();
        const decoded = vips.Image.newFromBuffer(source);
        images.push(decoded);
        const upright = decoded.autorot();
        images.push(upright);
        if (!allowed(upright)) return null;
        const scale = Math.min(1, THUMBHASH_EDGE / Math.max(upright.width, upright.height));
        const resized = scale < 1 ? upright.resize(scale) : upright.copy();
        images.push(resized);
        const srgb = resized.colourspace('srgb').cast('uchar');
        images.push(srgb);
        const rgba = srgb.hasAlpha() ? srgb : srgb.addalpha();
        images.push(rgba);
        const bytes = rgbaToThumbHash(rgba.width, rgba.height, rgba.writeToMemory());
        return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
      } catch {
        return null;
      } finally {
        dispose(images);
      }
    },
  };
}
