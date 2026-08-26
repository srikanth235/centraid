// Crop math (#711): CSS-scale the tile image by bbox fractions; no new blob variant.
export interface FaceBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceCropStyle {
  width: number;
  height: number;
  left: number;
  top: number;
}

// 1.6x covers snug detector boxes.
const CROP_MARGIN = 1.6;

export function faceCropStyle(
  bbox: FaceBBox | null | undefined,
  imgW: number | null | undefined,
  imgH: number | null | undefined,
  boxPx: number
): FaceCropStyle | null {
  if (!bbox || !imgW || !imgH || imgW <= 0 || imgH <= 0) return null;
  const { x, y, w, h } = bbox;
  if (![x, y, w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0)
    return null;

  const bboxPxW = w * imgW;
  const bboxPxH = h * imgH;
  const cropSide = Math.min(
    Math.max(bboxPxW, bboxPxH) * CROP_MARGIN,
    Math.min(imgW, imgH)
  );
  if (cropSide <= 0) return null;

  const scale = boxPx / cropSide;
  const centerX = (x + w / 2) * imgW;
  const centerY = (y + h / 2) * imgH;

  return {
    width: imgW * scale,
    height: imgH * scale,
    left: boxPx / 2 - centerX * scale,
    top: boxPx / 2 - centerY * scale,
  };
}
