// ThumbHash encoder (issue #419 M0.3): a ~5-25 byte, DCT-based placeholder a
// native client paints instantly while a real thumb streams in. Inline
// derivative variant `thumbhash`, base64 (unpadded) as its canonical form.
//
// `rgbaToThumbHash` is a faithful port of Evan Wallace's public-domain
// reference (https://github.com/evanw/thumbhash, js/thumbhash.js) — the
// algorithm is kept byte-identical so a hash this encodes decodes on any
// conforming ThumbHash decoder. The only edits are TypeScript ergonomics:
// `?? 0` on typed-array reads (noUncheckedIndexedAccess), booleans coerced to
// 0/1 before bit-shifts, and sparse-index writes made explicit. No numeric
// constant, quantization step, or byte-layout decision is changed.

/**
 * Encode an RGBA raster (row-major, 4 bytes/pixel, at most 100×100) to its
 * ThumbHash bytes. Throws when either edge exceeds 100 — callers downscale
 * first. Returns the compact hash (opaque images ~5-24 bytes, alpha larger).
 */
export function rgbaToThumbHash(w: number, h: number, rgba: Uint8Array): Uint8Array {
  if (w > 100 || h > 100) throw new Error(`${w}x${h} doesn't fit in 100x100`);
  const { PI, round, max, cos, abs } = Math;

  // Determine the average color, weighting each pixel by its alpha.
  let avg_r = 0;
  let avg_g = 0;
  let avg_b = 0;
  let avg_a = 0;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = (rgba[j + 3] ?? 0) / 255;
    avg_r += (alpha / 255) * (rgba[j] ?? 0);
    avg_g += (alpha / 255) * (rgba[j + 1] ?? 0);
    avg_b += (alpha / 255) * (rgba[j + 2] ?? 0);
    avg_a += alpha;
  }
  if (avg_a) {
    avg_r /= avg_a;
    avg_g /= avg_a;
    avg_b /= avg_a;
  }

  const hasAlpha = avg_a < w * h;
  const l_limit = hasAlpha ? 5 : 7; // luminance limit for the number of channels
  const lx = max(1, round((l_limit * w) / max(w, h)));
  const ly = max(1, round((l_limit * h) / max(w, h)));
  const l: number[] = []; // luminance
  const p: number[] = []; // yellow - blue
  const q: number[] = []; // red - green
  const a: number[] = []; // alpha

  // Convert the image from RGBA to LPQA (composite atop the average color).
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = (rgba[j + 3] ?? 0) / 255;
    const r = avg_r * (1 - alpha) + (alpha / 255) * (rgba[j] ?? 0);
    const g = avg_g * (1 - alpha) + (alpha / 255) * (rgba[j + 1] ?? 0);
    const b = avg_b * (1 - alpha) + (alpha / 255) * (rgba[j + 2] ?? 0);
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }

  // Encode using the DCT into DC (constant) and normalized AC (varying) terms.
  const encodeChannel = (channel: number[], nx: number, ny: number): [number, number[], number] => {
    let dc = 0;
    const ac: number[] = [];
    let scale = 0;
    const fx: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
        let f = 0;
        for (let x = 0; x < w; x++) fx[x] = cos((PI / w) * cx * (x + 0.5));
        for (let y = 0; y < h; y++) {
          const fy = cos((PI / h) * cy * (y + 0.5));
          for (let x = 0; x < w; x++) f += (channel[x + y * w] ?? 0) * (fx[x] ?? 0) * fy;
        }
        f /= w * h;
        if (cx || cy) {
          ac.push(f);
          scale = max(scale, abs(f));
        } else {
          dc = f;
        }
      }
    }
    if (scale) for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + (0.5 / scale) * (ac[i] ?? 0);
    return [dc, ac, scale];
  };
  const [l_dc, l_ac, l_scale] = encodeChannel(l, max(3, lx), max(3, ly));
  const [p_dc, p_ac, p_scale] = encodeChannel(p, 3, 3);
  const [q_dc, q_ac, q_scale] = encodeChannel(q, 3, 3);
  const [a_dc, a_ac, a_scale] = hasAlpha ? encodeChannel(a, 5, 5) : [0, [] as number[], 0];

  // Write the constants bytes to the output.
  const isLandscape = w > h;
  const header24 =
    round(63 * l_dc) |
    (round(31.5 + 31.5 * p_dc) << 6) |
    (round(31.5 + 31.5 * q_dc) << 12) |
    (round(31 * l_scale) << 18) |
    ((hasAlpha ? 1 : 0) << 23);
  const header16 =
    (isLandscape ? ly : lx) |
    (round(63 * p_scale) << 3) |
    (round(63 * q_scale) << 9) |
    ((isLandscape ? 1 : 0) << 15);
  const hash: number[] = [
    header24 & 255,
    (header24 >> 8) & 255,
    header24 >> 16,
    header16 & 255,
    header16 >> 8,
  ];
  const ac_start = hasAlpha ? 6 : 5;
  let ac_index = 0;
  if (hasAlpha) hash.push(round(15 * a_dc) | (round(15 * a_scale) << 4));

  // Write the varying AC terms to the output, two 4-bit nibbles per byte.
  for (const ac of hasAlpha ? [l_ac, p_ac, q_ac, a_ac] : [l_ac, p_ac, q_ac]) {
    for (const f of ac) {
      const idx = ac_start + (ac_index >> 1);
      hash[idx] = (hash[idx] ?? 0) | (round(15 * f) << ((ac_index++ & 1) << 2));
    }
  }
  return new Uint8Array(hash);
}
