import type { Box } from "./nms.js";

export interface ResizeTarget {
  width: number;
  height: number;
}

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

export function roundBox(box: Box): [number, number, number, number] {
  return [
    Math.round(box.x),
    Math.round(box.y),
    Math.round(box.width),
    Math.round(box.height),
  ];
}

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
