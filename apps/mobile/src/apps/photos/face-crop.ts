// The face-review crop math (issue #711, v4 4307 "the face crop") — the
// mobile twin of packages/blueprints/apps/photos/face-crop.ts. Duplicated
// rather than imported: the two are separate packages/runtimes (RN vs DOM),
// and the math itself is a handful of platform-free arithmetic lines, not a
// dependency worth reaching across a package boundary for. Keep the two in
// sync if the crop behaviour changes.
//
// There is no server-cropped thumbnail for a face region — `media_face_region`
// only carries `bbox_json` as a fraction of the FULL photograph (x, y, w, h,
// each 0..1, top-left origin — see the web twin's header for the schema
// source). So the crop tile paints the SAME source image every other tile
// uses and positions/scales it so the bbox fills the square — no new blob
// variant, no server or device work beyond a normal <Image>.
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
