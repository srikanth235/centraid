// Pure-math helpers for the faces capability (YuNet detection decode + SFace
// alignment), kept separate from src/capabilities/faces.ts so every formula
// here is unit-testable with synthetic tensors/points — no ONNX/sharp
// import in this file.

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export interface Point {
  x: number;
  y: number;
}

export interface YuNetLevelInput {
  /** Grid stride in input-image pixels (YuNet's 2023mar export uses strides 8, 16, 32). */
  stride: number;
  /** Feature map width/height in grid cells. */
  gridWidth: number;
  gridHeight: number;
  /** Row-major per-cell class logits, length gridWidth*gridHeight. */
  classScores: ArrayLike<number>;
  /** Row-major per-cell objectness logits, length gridWidth*gridHeight. */
  objectness: ArrayLike<number>;
  /** Row-major per-cell [dx, dy, dw, dh] box regression, length gridWidth*gridHeight*4. */
  boxes: ArrayLike<number>;
  /** Row-major per-cell 5-point landmark regression [x0,y0,...,x4,y4] relative to cell center, in stride units. Length gridWidth*gridHeight*10. */
  landmarks?: ArrayLike<number>;
}

export interface DecodedFace {
  box: { x: number; y: number; width: number; height: number };
  score: number;
  landmarks?: Point[];
}

/**
 * Decodes one YuNet feature-map level (one of its three strides) into
 * image-space boxes. The pinned 2023mar export exposes separate class and
 * objectness logits, combined as `sqrt(sigmoid(cls) * sigmoid(obj))`; box and
 * landmark regressions are offsets from the grid origin in stride units.
 * This matches OpenCV Zoo's YuNet post-processing and is exercised against
 * the actual pinned ONNX weights in the weekly live lane.
 */
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

/**
 * The standard ArcFace/SFace 5-point reference template for a 112x112
 * aligned face crop (left eye, right eye, nose tip, left mouth corner,
 * right mouth corner) — the same widely-published constants used by
 * insightface and reproduced across many MIT-licensed face-alignment
 * implementations.
 */
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

/**
 * Umeyama's least-squares 2D similarity transform (scale + rotation +
 * translation, no reflection): finds the transform that best maps `src`
 * points onto `dst` points in a least-squares sense. Used to align detected
 * face landmarks onto SFACE_TEMPLATE_112 before recognition.
 */
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

  // Closed-form rotation+scale for the no-reflection similarity case:
  // rotation angle = atan2(sxy - syx, sxx + syy); scale = (sxx+syy accounted
  // via the same numerator/denominator) / srcVar.
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

/**
 * Inverse-warps `image` into a `outWidth`x`outHeight` output using the
 * INVERSE of `forwardTransform` (a src->dst similarity) with bilinear
 * sampling — standard image-warp direction (for each output pixel, sample
 * the corresponding source location) so the output has no holes.
 */
export function warpAffine(
  image: RawImage,
  forwardTransform: SimilarityTransform,
  outWidth: number,
  outHeight: number
): RawImage {
  // Invert the similarity transform: forward is [a -b; b a] * p + t.
  // det = a^2+b^2 (a pure rotation+scale matrix, always invertible for scale != 0).
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
