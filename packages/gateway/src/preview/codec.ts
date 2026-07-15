// The gateway's raster preview codec (issue #405 §2): the concrete, npm-dep
// side of the `PreviewCodec` interface the vault package declares
// dependency-free. The vault runtime deliberately carries no raster decoder
// (packages/vault stays dep-light), so the gateway — which already holds
// plaintext on ingest, inside the owner's trust boundary — injects THIS into
// `VaultDb.previewCodec` and the blob-sweep backstop (`backfillPreviews`)
// downscales imported / weak-client / server-ingested images through it.
//
// PURE-JS ONLY, on purpose (issue #405 §2): `jpeg-js` (decode + encode) and
// `pngjs` (decode) run identically in the Electron main process and the Linux
// daemon with zero native build step — no node-gyp, no per-platform prebuilds,
// no WASM boot. The trade is speed: a pure-JS decode of a 24-MP original is
// hundreds of ms, which is exactly why generation is a BOUNDED, event-loop-
// yielding backstop (24 items/sweep) and never a foreground request path. The
// named upgrade path when throughput ever matters is `wasm-vips` (libvips
// compiled to WASM — SIMD downscaling, HEIC/AVIF/WebP decode) swapped in
// behind this same interface; nothing above the interface changes.
//
// Scope (issue #405 §2): JPEG and PNG in, JPEG out. GIF / WebP / video →
// `null` (unsupported → the browse surface's placeholder contract, issue
// #404, covers the miss). Gateway-side VIDEO decode is deliberately out of v0
// — poster frames are client-only where cheap.

import jpegJs from 'jpeg-js';
import { PNG } from 'pngjs';
import type { PreviewCodec, PreviewOutput } from '@centraid/vault';

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

/**
 * The injected codec (issue #405 §2). Decode → area-average downscale to
 * `maxEdge` → re-encode as JPEG q≈0.8. `null` for anything unsupported,
 * over-cap or corrupt — the sweep treats that as "skip, the placeholder
 * covers it". The output is always JPEG regardless of input type (a PNG
 * screenshot's thumbnail is a JPEG), which is what the browse grid paints.
 */
export function createImagePreviewCodec(): PreviewCodec {
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
  };
}
