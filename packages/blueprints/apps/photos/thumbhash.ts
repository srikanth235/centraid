// Client ThumbHash (issue #419): a ~5-25 byte DCT placeholder painted instantly
// while the real thumb streams. A faithful port of Evan Wallace's public-domain
// reference (github.com/evanw/thumbhash) so the bytes decode on any conforming
// decoder — produced here off the same canvas decode the thumb/dHash pay for;
// the gateway backstop only fills what a client couldn't. Kept dependency-free
// (no kit imports) so it is unit-testable outside the browser, mirroring the
// gateway's own thumbhash.ts. TS ergonomics only (matching that file): `?? 0`
// on typed-array/sparse reads (noUncheckedIndexedAccess); no numeric constant,
// quantization step, or byte-layout decision changes.

/**
 * Encode a ≤100×100 RGBA raster (row-major, 4 bytes/pixel) to its ThumbHash as
 * unpadded standard base64. Returns null when either edge exceeds 100 (callers
 * downscale first) — a missing placeholder is a blank tile, never a failure.
 */
export function thumbHashFromRgba(
  w: number,
  h: number,
  rgba: Uint8Array | Uint8ClampedArray,
): string | null {
  if (w > 100 || h > 100) return null;
  const { PI, round, max, cos, abs } = Math;
  let avgR = 0;
  let avgG = 0;
  let avgB = 0;
  let avgA = 0;
  for (let i = 0, j = 0; i < w * h; i += 1, j += 4) {
    const alpha = (rgba[j + 3] ?? 0) / 255;
    avgR += (alpha / 255) * (rgba[j] ?? 0);
    avgG += (alpha / 255) * (rgba[j + 1] ?? 0);
    avgB += (alpha / 255) * (rgba[j + 2] ?? 0);
    avgA += alpha;
  }
  if (avgA) {
    avgR /= avgA;
    avgG /= avgA;
    avgB /= avgA;
  }
  const hasAlpha = avgA < w * h;
  const lLimit = hasAlpha ? 5 : 7;
  const lx = max(1, round((lLimit * w) / max(w, h)));
  const ly = max(1, round((lLimit * h) / max(w, h)));
  const l: number[] = [];
  const p: number[] = [];
  const q: number[] = [];
  const a: number[] = [];
  for (let i = 0, j = 0; i < w * h; i += 1, j += 4) {
    const alpha = (rgba[j + 3] ?? 0) / 255;
    const r = avgR * (1 - alpha) + (alpha / 255) * (rgba[j] ?? 0);
    const g = avgG * (1 - alpha) + (alpha / 255) * (rgba[j + 1] ?? 0);
    const b = avgB * (1 - alpha) + (alpha / 255) * (rgba[j + 2] ?? 0);
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }
  const encodeChannel = (channel: number[], nx: number, ny: number): [number, number[], number] => {
    let dc = 0;
    const ac: number[] = [];
    let scale = 0;
    const fx: number[] = [];
    for (let cy = 0; cy < ny; cy += 1) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx += 1) {
        let f = 0;
        for (let x = 0; x < w; x += 1) fx[x] = cos((PI / w) * cx * (x + 0.5));
        for (let y = 0; y < h; y += 1) {
          const fy = cos((PI / h) * cy * (y + 0.5));
          for (let x = 0; x < w; x += 1) f += (channel[x + y * w] ?? 0) * (fx[x] ?? 0) * fy;
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
    if (scale) for (let i = 0; i < ac.length; i += 1) ac[i] = 0.5 + (0.5 / scale) * (ac[i] ?? 0);
    return [dc, ac, scale];
  };
  const [lDc, lAc, lScale] = encodeChannel(l, max(3, lx), max(3, ly));
  const [pDc, pAc, pScale] = encodeChannel(p, 3, 3);
  const [qDc, qAc, qScale] = encodeChannel(q, 3, 3);
  const [aDc, aAc, aScale] = hasAlpha ? encodeChannel(a, 5, 5) : [0, [] as number[], 0];
  const isLandscape = w > h;
  const header24 =
    round(63 * lDc) |
    (round(31.5 + 31.5 * pDc) << 6) |
    (round(31.5 + 31.5 * qDc) << 12) |
    (round(31 * lScale) << 18) |
    ((hasAlpha ? 1 : 0) << 23);
  const header16 =
    (isLandscape ? ly : lx) |
    (round(63 * pScale) << 3) |
    (round(63 * qScale) << 9) |
    ((isLandscape ? 1 : 0) << 15);
  const hash: number[] = [
    header24 & 255,
    (header24 >> 8) & 255,
    header24 >> 16,
    header16 & 255,
    header16 >> 8,
  ];
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  if (hasAlpha) hash.push(round(15 * aDc) | (round(15 * aScale) << 4));
  for (const ac of hasAlpha ? [lAc, pAc, qAc, aAc] : [lAc, pAc, qAc]) {
    for (const f of ac) {
      const idx = acStart + (acIndex >> 1);
      hash[idx] = (hash[idx] ?? 0) | (round(15 * f) << ((acIndex++ & 1) << 2));
    }
  }
  let binary = '';
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '');
}

/**
 * Decode one bitmap to ≤100 px RGBA on a canvas and hash it (issue #419) — the
 * same canvas raster codec the thumb/dHash use, so no extra image fetch.
 */
export function thumbHashFromImage(img: HTMLImageElement | ImageBitmap): string | null {
  try {
    const long = Math.max(img.width, img.height);
    const scale = Math.min(1, 100 / long);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;
    g.drawImage(img, 0, 0, w, h);
    return thumbHashFromRgba(w, h, g.getImageData(0, 0, w, h).data);
  } catch {
    return null; // a missing placeholder is a blank tile, never a failed upload
  }
}
