// The face-review crop math (issue #711, v4 4307 "the face crop"). There is
// no server-cropped thumbnail for a face region — `media_face_region` only
// carries `bbox_json` as a fraction of the FULL photograph (x, y, w, h, each
// 0..1, top-left origin; see `enrich-publishers.ts`'s `FaceRegionPayload` and
// `enrich.test.ts`'s fixtures). So the crop tile paints the SAME source
// image every other tile uses and positions/scales it in CSS so the bbox
// fills the square — no new blob variant, no server work.
//
// Pure and framework-free so web and native import one computation.
export interface FaceBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceCropStyle {
  /** The <img>'s rendered width/height, in the SAME px unit as `boxPx`. */
  width: number;
  height: number;
  /** Where the image's top-left lands relative to the crop box's top-left —
   *  negative when the face sits away from the image's own top-left. */
  left: number;
  top: number;
}

// How much room around the tightest square that contains the bbox: a raw
// face-detector box is snug (often clipping forehead/chin), and the
// prototype's crop reads as a small portrait, not a passport photo. 1.6x
// mirrors the common "add 30% margin per side" face-crop convention.
const CROP_MARGIN = 1.6;

/**
 * Where to draw `imgW`×`imgH` source image, scaled, inside a `boxPx`×`boxPx`
 * square so the bbox is centred and (mostly) fills it. Returns `null` when
 * there isn't enough information to crop honestly — the caller falls back to
 * painting the plain, uncropped photograph rather than guessing a position.
 */
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
