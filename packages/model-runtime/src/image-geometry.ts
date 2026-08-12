// Pure geometry helpers shared by the ocr and faces capabilities: bounding
// the detector input to a max side length rounded to a stride multiple
// (PP-OCR's own "resize_image_type0" preprocessing), and mapping a box
// detected on a resized image back to original-image pixel coordinates
// (the wire contract's `box` field is always in the ORIGINAL image's
// coordinate space, scaled from `originalWidth`/`originalHeight` when the
// caller supplies them).

import type { Box } from "./nms.js";

export interface ResizeTarget {
  width: number;
  height: number;
}

/**
 * Scales so the longer side is at most `maxSide` (never upscales), then
 * rounds both dimensions to the nearest positive multiple of `multiple` —
 * the shape most detector ONNX exports require (their stride/pooling
 * factors need input dims divisible by the network's total stride).
 */
export function computeBoundedMultipleResize(
  width: number,
  height: number,
  maxSide: number,
  multiple: number
): ResizeTarget {
  const longSide = Math.max(width, height);
  const scale = longSide > maxSide ? maxSide / longSide : 1;

  const roundToMultiple = (value: number) =>
    Math.max(multiple, Math.round((value * scale) / multiple) * multiple);

  return { width: roundToMultiple(width), height: roundToMultiple(height) };
}

/** Maps a box detected on a resized image back to the original image's pixel coordinates. */
export function scaleBoxToOriginal(
  box: Box,
  resized: ResizeTarget,
  original: ResizeTarget
): Box {
  const scaleX = original.width / resized.width;
  const scaleY = original.height / resized.height;
  return {
    x: box.x * scaleX,
    y: box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
  };
}

/** Rounds a box to integer pixels for the wire contract's `[x, y, w, h]` int box. */
export function roundBox(box: Box): [number, number, number, number] {
  return [
    Math.round(box.x),
    Math.round(box.y),
    Math.round(box.width),
    Math.round(box.height),
  ];
}

/**
 * Rounds AND clamps a box into `[0, width] x [0, height]`, guaranteeing
 * `x + resultWidth <= width` and `y + resultHeight <= height` exactly (never
 * "close enough"). The typed vault command rejects any box that overshoots
 * the item's declared `originalWidth`/`originalHeight`, so every box a
 * recognition handler returns MUST go through this —
 * not just `roundBox` — whenever it is expressed against a caller-declared
 * dimension. Independently rounding x/x+width (as plain `Math.round` on each
 * field would) can push `x + width` one pixel past the bound purely from
 * rounding; clamping x2/y2 to the bound directly (then deriving width/height
 * from the clamped pair) cannot.
 */
export function roundAndClampBox(
  box: Box,
  width: number,
  height: number
): [number, number, number, number] {
  const x1 = Math.max(0, Math.min(width, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(height, Math.round(box.y)));
  const x2 = Math.max(x1, Math.min(width, Math.round(box.x + box.width)));
  const y2 = Math.max(y1, Math.min(height, Math.round(box.y + box.height)));
  return [x1, y1, x2 - x1, y2 - y1];
}
