// Pure-math greedy non-maximum suppression, shared by the faces (YuNet) and
// ocr detection postprocess paths. No ONNX/sharp import here on purpose —
// this module is exercised directly by vitest with synthetic boxes, without
// needing `bun run setup` (issue #724 W8: the vitest suite must pass with no
// onnxruntime-node installed).

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScoredBox {
  box: Box;
  score: number;
}

export function boxArea(box: Box): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

/** Intersection-over-union of two axis-aligned boxes in [x, y, w, h] form. */
export function iou(a: Box, b: Box): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);

  const interWidth = Math.max(0, interX2 - interX1);
  const interHeight = Math.max(0, interY2 - interY1);
  const intersection = interWidth * interHeight;
  if (intersection <= 0) {
    return 0;
  }

  const union = boxArea(a) + boxArea(b) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export interface NmsOptions {
  /** Boxes whose IoU with a kept box exceeds this are suppressed. */
  iouThreshold: number;
  /** Optional cap on the number of boxes returned, applied after sorting by score. */
  topK?: number;
}

/**
 * Greedy NMS: sort by score descending, then repeatedly keep the top-scoring
 * remaining box and drop every other box that overlaps it above
 * `iouThreshold`. Standard formulation used by both YuNet (faces) and DB
 * (ocr) reference implementations.
 */
export function nonMaxSuppression(
  boxes: readonly ScoredBox[],
  options: NmsOptions
): ScoredBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: ScoredBox[] = [];

  for (const candidate of sorted) {
    const suppressed = kept.some(
      (keptBox) => iou(keptBox.box, candidate.box) > options.iouThreshold
    );
    if (!suppressed) {
      kept.push(candidate);
      if (options.topK !== undefined && kept.length >= options.topK) {
        break;
      }
    }
  }

  return kept;
}
