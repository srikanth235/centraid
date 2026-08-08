// Pure-math DB (Differentiable Binarization) postprocess for the PP-OCR
// detector, exercised directly by vitest with synthetic probability maps —
// no ONNX import here.
//
// Scope note (be honest about the simplification, per the repo's "honest
// absence" rule): the reference PaddleOCR/RapidOCR postprocess fits a
// rotated minAreaRect around each contour and perspective-unwarps the crop,
// so it can recover angled or curved text lines. This module instead keeps
// the axis-aligned bounding box of each connected component. That is
// correct and sufficient for the overwhelmingly common case (horizontal or
// near-horizontal text, which is most of what a personal photo/document
// library contains) and keeps the box shape compatible with the wire
// contract's `[x, y, w, h]` box, which has no rotation field. Recovering
// rotated boxes would need perspective-warp crops upstream of recognition
// too; that is out of scope for this pass and is called out again in
// README.md as a known gap for the integrator.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Thresholds a probability map (row-major, `width * height` floats in
 * 0..1) into a binary mask. DB's own "binarization" is a soft, learned step
 * baked into the model; this is the postprocess-side hard threshold applied
 * to the model's output probability map, matching PaddleOCR's
 * `thresh` (default 0.3) db_postprocess parameter.
 */
export function binarizeProbabilityMap(
  probs: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 0.3
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = (probs[i] ?? 0) >= threshold ? 1 : 0;
  }
  return mask;
}

export interface ConnectedComponent {
  box: Box;
  /** Pixel count of the component — used both for filtering tiny noise and for the unclip distance formula. */
  area: number;
}

/**
 * 4-connectivity flood fill over a binary mask, returning the axis-aligned
 * bounding box and pixel area of every connected foreground component.
 * Iterative (explicit stack) so a large mask cannot blow the call stack.
 */
export function findConnectedComponents(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  minArea = 1
): ConnectedComponent[] {
  const visited = new Uint8Array(width * height);
  const components: ConnectedComponent[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) {
      continue;
    }

    stack.push(start);
    visited[start] = 1;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let area = 0;

    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = Math.floor(index / width);

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      area++;

      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          stack.push(neighbor);
        }
      }
    }

    if (area >= minArea) {
      components.push({
        box: {
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        },
        area,
      });
    }
  }

  return components;
}

/**
 * Expands a box outward, approximating DB's polygon "unclip" step (the
 * probability map is trained to under-shoot the true text region, so the
 * detector always grows boxes back out before cropping). Uses PaddleOCR's
 * own distance formula — `distance = area * unclipRatio / perimeter` —
 * applied as uniform padding on all four sides of the axis-aligned box
 * (the polygon-offset equivalent for a rectangle). Default ratio 1.5
 * matches PP-OCR's default `unclip_ratio`.
 */
export function unclipBox(box: Box, area: number, unclipRatio = 1.5): Box {
  const perimeter = 2 * (box.width + box.height);
  if (perimeter <= 0) {
    return box;
  }
  const distance = (area * unclipRatio) / perimeter;
  return {
    x: box.x - distance,
    y: box.y - distance,
    width: box.width + distance * 2,
    height: box.height + distance * 2,
  };
}

/** Clamps a box to the [0, width) x [0, height) image bounds, rounding to integer pixels. */
export function clampBoxToImage(box: Box, width: number, height: number): Box {
  const x1 = Math.max(0, Math.min(width, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(height, Math.round(box.y)));
  const x2 = Math.max(0, Math.min(width, Math.round(box.x + box.width)));
  const y2 = Math.max(0, Math.min(height, Math.round(box.y + box.height)));
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  };
}

/**
 * Mean probability within a box region — used as the detection confidence
 * score PaddleOCR filters boxes by (default `box_thresh` 0.5), computed over
 * the ORIGINAL (unclipped) box so it reflects the model's own confidence in
 * that specific region rather than the padded crop.
 */
export function meanProbabilityInBox(
  probs: ArrayLike<number>,
  width: number,
  box: Box
): number {
  const x1 = Math.max(0, Math.floor(box.x));
  const y1 = Math.max(0, Math.floor(box.y));
  const x2 = Math.max(x1, Math.ceil(box.x + box.width));
  const y2 = Math.max(y1, Math.ceil(box.y + box.height));

  let sum = 0;
  let count = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      sum += probs[y * width + x] ?? 0;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

export interface DetectedTextBox {
  box: Box;
  score: number;
}

export interface DbPostprocessOptions {
  binaryThreshold?: number;
  boxScoreThreshold?: number;
  unclipRatio?: number;
  minArea?: number;
}

/**
 * Full DB postprocess pipeline: threshold -> connected components -> score
 * filter -> unclip -> clamp to image bounds. Pure function of a probability
 * map; the caller is responsible for getting that map out of the detector
 * ONNX session (see src/capabilities/ocr.ts).
 */
export function dbPostprocess(
  probs: ArrayLike<number>,
  width: number,
  height: number,
  options: DbPostprocessOptions = {}
): DetectedTextBox[] {
  const {
    binaryThreshold = 0.3,
    boxScoreThreshold = 0.5,
    unclipRatio = 1.5,
    minArea = 4,
  } = options;

  const mask = binarizeProbabilityMap(probs, width, height, binaryThreshold);
  const components = findConnectedComponents(mask, width, height, minArea);

  const results: DetectedTextBox[] = [];
  for (const component of components) {
    const score = meanProbabilityInBox(probs, width, component.box);
    if (score < boxScoreThreshold) {
      continue;
    }
    const expanded = unclipBox(component.box, component.area, unclipRatio);
    const clamped = clampBoxToImage(expanded, width, height);
    if (clamped.width <= 0 || clamped.height <= 0) {
      continue;
    }
    results.push({ box: clamped, score });
  }
  return results;
}
