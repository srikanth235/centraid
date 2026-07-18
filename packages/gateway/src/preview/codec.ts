// The gateway's raster preview codec (issue #405 §2): the concrete, npm-dep
// side of the `PreviewCodec` interface the vault package declares
// dependency-free. The vault runtime deliberately carries no raster decoder
// (packages/vault stays dep-light), so the gateway — which already holds
// plaintext on ingest, inside the owner's trust boundary — injects THIS into
// `VaultDb.previewCodec` and the blob-sweep backstop (`backfillPreviews`)
// downscales imported / weak-client / server-ingested images through it.
//
// The portable implementation remains as a deterministic fallback and test
// oracle. Production selects native sharp/libvips for the daemon and the
// wasm-vips implementation for Electron through BuildGatewayOptions.
//
// Scope (issue #405 §2): JPEG and PNG in, JPEG out. GIF / WebP / video →
// `null` (unsupported → the browse surface's placeholder contract, issue
// #404, covers the miss). Gateway-side VIDEO decode is deliberately out of v0
// — poster frames are client-only where cheap.

import jpegJs from 'jpeg-js';
import { PNG } from 'pngjs';
import type { PreviewCodec, PreviewOutput } from '@centraid/vault';
import { rgbaToThumbHash } from './thumbhash.js';

/** ThumbHash requires ≤100 px on each edge; the placeholder is coarse anyway. */
const THUMBHASH_EDGE = 100;

/**
 * Refuse inputs whose decoded raster would blow memory (issue #405 §2: "cap
 * input dimensions to bound memory"). 12k on either edge, and a total-pixel
 * ceiling so a pathological 12000×12000 (576 MB of RGBA) is still refused.
 * A refused input returns `null` — the same "unsupported, render a
 * placeholder" outcome as an unknown type, never a throw that could stall the
 * sweep.
 */
const MAX_INPUT_EDGE = 12_000;
const MAX_INPUT_PIXELS = 40_000_000; // ~40 MP — comfortably above phone cameras

/** Output JPEG quality (issue #405 §2): ~0.8 for both rungs. jpeg-js is 0-100. */
const OUTPUT_QUALITY = 80;

/** A decoded RGBA raster — the common shape both decoders normalize to. */
interface Raster {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

/** Decode JPEG/PNG to RGBA, or null for an unsupported / over-cap / bad input. */
function decode(source: Buffer, mediaType: string): Raster | null {
  const type = mediaType.toLowerCase();
  try {
    if (type === 'image/jpeg' || type === 'image/jpg') {
      // `useTArray` returns a Uint8Array (no Buffer copy); the decoder's own
      // resolution/memory caps are a first line of defense before ours.
      const img = jpegJs.decode(source, {
        useTArray: true,
        maxResolutionInMP: MAX_INPUT_PIXELS / 1_000_000,
        maxMemoryUsageInMB: 512,
        formatAsRGBA: true,
      });
      return withinCaps(img.width, img.height)
        ? { width: img.width, height: img.height, data: img.data }
        : null;
    }
    if (type === 'image/png') {
      const png = PNG.sync.read(source);
      return withinCaps(png.width, png.height)
        ? { width: png.width, height: png.height, data: png.data }
        : null;
    }
  } catch {
    // A corrupt or truncated file is a miss, not a crash — the placeholder
    // contract (issue #404) covers it.
    return null;
  }
  // GIF / WebP / video / anything else — unsupported in v0 (issue #405 §2).
  return null;
}

/** Both dimension caps in one predicate (issue #405 §2 memory bound). */
function withinCaps(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  if (width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE) return false;
  return width * height <= MAX_INPUT_PIXELS;
}

/**
 * Box-filter (area-average) downscale to fit `maxEdge` on the long side,
 * WITHOUT upscaling. Every source pixel maps to exactly one destination cell
 * (floor mapping) and accumulates into it, then each cell divides by its
 * contributor count — an unweighted area average. O(source pixels), correct
 * enough for a thumbnail/preview, and dependency-free (no separable-kernel
 * resampler to carry). A source already within `maxEdge` returns a 1:1 copy
 * (re-encoded to JPEG by the caller) rather than upscaling.
 */
function downscaleRaster(src: Raster, maxEdge: number): Raster {
  const longEdge = Math.max(src.width, src.height);
  const scale = Math.min(1, maxEdge / longEdge);
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  if (dw === src.width && dh === src.height) return src; // no resample needed

  // Accumulators sized to the destination — sums per channel plus a per-cell
  // contributor count (interior cells all get the same count, edge cells fewer
  // when the ratio isn't integral, which is exactly what an area average wants).
  // `?? 0` on every typed-array read: `noUncheckedIndexedAccess` types an
  // index access as `number | undefined`, and while every index here is
  // provably in-bounds, the coalesce is free at runtime and keeps the loops
  // honest without a blanket assertion.
  const cells = dw * dh;
  const sum = new Float64Array(cells * 4);
  const count = new Uint32Array(cells);
  for (let sy = 0; sy < src.height; sy += 1) {
    const dy = Math.min(dh - 1, Math.floor((sy * dh) / src.height));
    for (let sx = 0; sx < src.width; sx += 1) {
      const dx = Math.min(dw - 1, Math.floor((sx * dw) / src.width));
      const s = (sy * src.width + sx) * 4;
      const d = dy * dw + dx;
      const so = d * 4;
      sum[so] = (sum[so] ?? 0) + (src.data[s] ?? 0);
      sum[so + 1] = (sum[so + 1] ?? 0) + (src.data[s + 1] ?? 0);
      sum[so + 2] = (sum[so + 2] ?? 0) + (src.data[s + 2] ?? 0);
      sum[so + 3] = (sum[so + 3] ?? 0) + (src.data[s + 3] ?? 0);
      count[d] = (count[d] ?? 0) + 1;
    }
  }
  const out = new Uint8Array(cells * 4);
  for (let d = 0; d < cells; d += 1) {
    const n = count[d] || 1;
    const o = d * 4;
    out[o] = Math.round((sum[o] ?? 0) / n);
    out[o + 1] = Math.round((sum[o + 1] ?? 0) / n);
    out[o + 2] = Math.round((sum[o + 2] ?? 0) / n);
    out[o + 3] = Math.round((sum[o + 3] ?? 0) / n);
  }
  return { width: dw, height: dh, data: out };
}

/** ITU-R BT.601 luma, matching the Photos client's canvas dHash. */
function luminance(src: Raster, x: number, y: number): number {
  const offset = (y * src.width + x) * 4;
  return (
    0.299 * (src.data[offset] ?? 0) +
    0.587 * (src.data[offset + 1] ?? 0) +
    0.114 * (src.data[offset + 2] ?? 0)
  );
}

/** Browser canvas scales every source to the fixed 9×8 dHash sample grid. */
function sampledLuminance(src: Raster, targetX: number, targetY: number): number {
  const sx = Math.max(0, Math.min(src.width - 1, ((targetX + 0.5) * src.width) / 9 - 0.5));
  const sy = Math.max(0, Math.min(src.height - 1, ((targetY + 0.5) * src.height) / 8 - 0.5));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(src.width - 1, x0 + 1);
  const y1 = Math.min(src.height - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const top = luminance(src, x0, y0) * (1 - fx) + luminance(src, x1, y0) * fx;
  const bottom = luminance(src, x0, y1) * (1 - fx) + luminance(src, x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** 64-bit difference hash: left sample brighter than its right neighbour. */
function perceptualHash(src: Raster): string {
  let hex = '';
  for (let row = 0; row < 8; row += 1) {
    let byte = 0;
    for (let col = 0; col < 8; col += 1) {
      const left = sampledLuminance(src, col, row);
      const right = sampledLuminance(src, col + 1, row);
      byte = (byte << 1) | (left > right ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * The injected codec (issue #405 §2). Decode → area-average downscale to
 * `maxEdge` → re-encode as JPEG q≈0.8. `null` for anything unsupported,
 * over-cap or corrupt — the sweep treats that as "skip, the placeholder
 * covers it". The output is always JPEG regardless of input type (a PNG
 * screenshot's thumbnail is a JPEG), which is what the browse grid paints.
 */
export function createPortableImagePreviewCodec(): PreviewCodec {
  return {
    downscale(source: Buffer, mediaType: string, maxEdge: number): PreviewOutput | null {
      const raster = decode(source, mediaType);
      if (!raster) return null;
      try {
        const scaled = downscaleRaster(raster, maxEdge);
        const encoded = jpegJs.encode(
          { data: scaled.data, width: scaled.width, height: scaled.height },
          OUTPUT_QUALITY,
        );
        return {
          bytes: Buffer.from(encoded.data),
          mediaType: 'image/jpeg',
          width: scaled.width,
          height: scaled.height,
        };
      } catch {
        return null;
      }
    },
    perceptualHash(source: Buffer, mediaType: string): string | null {
      const raster = decode(source, mediaType);
      return raster ? perceptualHash(raster) : null;
    },
    thumbhash(source: Buffer, mediaType: string): string | null {
      const raster = decode(source, mediaType);
      if (!raster) return null;
      try {
        // ThumbHash caps at 100×100 — downscale first (a no-op copy when the
        // source already fits), then encode the RGBA to the compact hash.
        const small = downscaleRaster(raster, THUMBHASH_EDGE);
        const bytes = rgbaToThumbHash(small.width, small.height, small.data);
        // Canonical form: unpadded standard base64 (validated the same way on
        // the ingress side, so a device- and a codec-produced hash match).
        return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
      } catch {
        return null;
      }
    },
  };
}

/** Production default: native libvips work stays off the gateway JS thread. */
export function createImagePreviewCodec(
  nativeLoader: () => Promise<PreviewCodec | undefined> = () =>
    import('./native-codec.js').then(({ createNativeImagePreviewCodec }) =>
      createNativeImagePreviewCodec(),
    ),
): PreviewCodec {
  const portable = createPortableImagePreviewCodec();
  let native: Promise<PreviewCodec | undefined> | undefined;
  const loadNative = (): Promise<PreviewCodec | undefined> => {
    native ??= nativeLoader().catch(() => undefined);
    return native;
  };
  const withFallback = async <T>(
    nativeCall: (codec: PreviewCodec) => T | Promise<T>,
    portableCall: () => T | Promise<T>,
  ): Promise<T> => {
    const codec = await loadNative();
    if (!codec) return await portableCall();
    try {
      return await nativeCall(codec);
    } catch {
      return await portableCall();
    }
  };
  return {
    downscale: (source, mediaType, maxEdge) =>
      withFallback(
        (codec) => codec.downscale(source, mediaType, maxEdge),
        () => portable.downscale(source, mediaType, maxEdge),
      ),
    perceptualHash: (source, mediaType) =>
      withFallback(
        (codec) => codec.perceptualHash(source, mediaType),
        () => portable.perceptualHash(source, mediaType),
      ),
    thumbhash: (source, mediaType) =>
      withFallback(
        (codec) => codec.thumbhash(source, mediaType),
        () => portable.thumbhash(source, mediaType),
      ),
  };
}
