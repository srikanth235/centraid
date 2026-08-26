// Pure-math helpers for faces (YuNet decode + SFace alignment). Separate from
// src/capabilities/faces.ts so every formula is unit-testable — no ONNX/sharp.

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export interface Point {
  x: number;
  y: number;
}

export interface YuNetLevelInput {
  /** Grid stride in input-image pixels (YuNet 2023mar: 8, 16, 32). */
  stride: number;
  gridWidth: number;
  gridHeight: number;
  classScores: ArrayLike<number>;
  objectness: ArrayLike<number>;
  boxes: ArrayLike<number>;
  /** Row-major 5-point landmarks relative to cell center, stride units. */
  landmarks?: ArrayLike<number>;
}

export interface DecodedFace {
  box: { x: number; y: number; width: number; height: number };
  score: number;
  landmarks?: Point[];
}

/** Score is `sqrt(cls * obj)`; box/landmark offsets are in stride units. */
export function decodeYuNetLevel(
  input: YuNetLevelInput,
  scoreThreshold: number
): DecodedFace[] {
  const {
    stride,
    gridWidth,
    gridHeight,
    classScores,
    objectness,
    boxes,
    landmarks,
  } = input;
  const results: DecodedFace[] = [];

  for (let row = 0; row < gridHeight; row++) {
    for (let col = 0; col < gridWidth; col++) {
      const cellIndex = row * gridWidth + col;
      const classScore = Math.max(0, Math.min(1, classScores[cellIndex] ?? 0));
      const objectScore = Math.max(0, Math.min(1, objectness[cellIndex] ?? 0));
      const score = Math.sqrt(classScore * objectScore);
      if (score < scoreThreshold) {
        continue;
      }

      const dx = boxes[cellIndex * 4] ?? 0;
      const dy = boxes[cellIndex * 4 + 1] ?? 0;
      const dw = boxes[cellIndex * 4 + 2] ?? 0;
      const dh = boxes[cellIndex * 4 + 3] ?? 0;

      const width = Math.exp(dw) * stride;
      const height = Math.exp(dh) * stride;
      const centerX = (col + dx) * stride;
      const centerY = (row + dy) * stride;

      let points: Point[] | undefined;
      if (landmarks) {
        points = [];
        for (let p = 0; p < 5; p++) {
          const lx = landmarks[cellIndex * 10 + p * 2] ?? 0;
          const ly = landmarks[cellIndex * 10 + p * 2 + 1] ?? 0;
          points.push({ x: (col + lx) * stride, y: (row + ly) * stride });
        }
      }

      results.push({
        box: { x: centerX - width / 2, y: centerY - height / 2, width, height },
        score,
        landmarks: points,
      });
    }
  }

  return results;
}

/** ArcFace/SFace 5-point template for a 112x112 crop (L-eye, R-eye, nose, L-mouth, R-mouth). */
export const SFACE_TEMPLATE_112: readonly Point[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];

export interface SimilarityTransform {
  /** 2x2 scale-rotation matrix, row-major: [[a, b], [-b, a]]. */
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/** Umeyama 2D similarity (no reflection): maps `src` onto `dst`. */
export function computeSimilarityTransform(
  src: readonly Point[],
  dst: readonly Point[]
): SimilarityTransform {
  if (src.length !== dst.length || src.length === 0) {
    throw new Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  }
  const n = src.length;

  const srcMean = { x: 0, y: 0 };
  const dstMean = { x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    srcMean.x += (src[i] as Point).x / n;
    srcMean.y += (src[i] as Point).y / n;
    dstMean.x += (dst[i] as Point).x / n;
    dstMean.y += (dst[i] as Point).y / n;
  }

  let sxx = 0;
  let sxy = 0;
  let syx = 0;
  let syy = 0;
  let srcVar = 0;
  for (let i = 0; i < n; i++) {
    const sx = (src[i] as Point).x - srcMean.x;
    const sy = (src[i] as Point).y - srcMean.y;
    const dx = (dst[i] as Point).x - dstMean.x;
    const dy = (dst[i] as Point).y - dstMean.y;
    sxx += sx * dx;
    sxy += sx * dy;
    syx += sy * dx;
    syy += sy * dy;
    srcVar += sx * sx + sy * sy;
  }

  // No-reflection similarity: angle = atan2(sxy - syx, sxx + syy).
  const rotationNumerator = sxy - syx;
  const rotationDenominator = sxx + syy;
  const angle = Math.atan2(rotationNumerator, rotationDenominator);
  const scale =
    Math.hypot(rotationDenominator, rotationNumerator) /
    (srcVar === 0 ? 1 : srcVar);

  const a = scale * Math.cos(angle);
  const b = scale * Math.sin(angle);

  const tx = dstMean.x - (a * srcMean.x - b * srcMean.y);
  const ty = dstMean.y - (b * srcMean.x + a * srcMean.y);

  return { a, b, tx, ty };
}

export function applyTransform(
  transform: SimilarityTransform,
  point: Point
): Point {
  return {
    x: transform.a * point.x - transform.b * point.y + transform.tx,
    y: transform.b * point.x + transform.a * point.y + transform.ty,
  };
}

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export function warpAffine(
  image: RawImage,
  forwardTransform: SimilarityTransform,
  outWidth: number,
  outHeight: number
): RawImage {
  // Invert [a -b; b a] * p + t. det = a²+b²; identity if scale is 0.
  const det = forwardTransform.a ** 2 + forwardTransform.b ** 2;
  const inv =
    det === 0
      ? { a: 1, b: 0, tx: 0, ty: 0 }
      : {
          a: forwardTransform.a / det,
          b: -forwardTransform.b / det,
          tx:
            (-forwardTransform.a * forwardTransform.tx -
              forwardTransform.b * forwardTransform.ty) /
            det,
          ty:
            (forwardTransform.b * forwardTransform.tx -
              forwardTransform.a * forwardTransform.ty) /
            det,
        };

  const out = new Uint8Array(outWidth * outHeight * 3);

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const src = applyTransform(inv, { x, y });
      const sample = bilinearSample(image, src.x, src.y);
      const outIndex = (y * outWidth + x) * 3;
      out[outIndex] = sample[0];
      out[outIndex + 1] = sample[1];
      out[outIndex + 2] = sample[2];
    }
  }

  return { data: out, width: outWidth, height: outHeight };
}

function bilinearSample(
  image: RawImage,
  x: number,
  y: number
): [number, number, number] {
  if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) {
    return [0, 0, 0];
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;

  const pixel = (px: number, py: number, channel: number) =>
    image.data[(py * image.width + px) * 3 + channel] ?? 0;

  const out: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const top = pixel(x0, y0, channel) * (1 - fx) + pixel(x1, y0, channel) * fx;
    const bottom =
      pixel(x0, y1, channel) * (1 - fx) + pixel(x1, y1, channel) * fx;
    out[channel] = Math.round(top * (1 - fy) + bottom * fy);
  }
  return out;
}
