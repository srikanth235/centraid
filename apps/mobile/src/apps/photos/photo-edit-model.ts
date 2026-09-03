export {
  PHOTOS_SAVE_AS_NEW as SAVE_AS_NEW,
  PHOTOS_SAVE_AS_NEW_EXPLANATION as SAVE_AS_NEW_EXPLANATION,
} from "@centraid/blueprints/apps/photos/shared-copy";

export const EDITOR_TITLE = "Crop and rotate";

export const EDITOR_CANCEL = "Cancel";

export function editorMeta(capturedAt?: string): string {
  const when = capturedAt ? new Date(capturedAt) : undefined;
  if (!when || Number.isNaN(when.getTime())) return "from a photograph";
  return `from a photograph taken ${when.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  })}`;
}

export const STRAIGHTEN_STEP = 1;
export const STRAIGHTEN_LIMIT = 15;

export function nextStraighten(degrees: number): number {
  const next = degrees - STRAIGHTEN_STEP;
  return next < -STRAIGHTEN_LIMIT ? 0 : next;
}

export function signedDegrees(degrees: number): string {
  if (degrees === 0) return "0°";
  return degrees < 0 ? `−${Math.abs(degrees)}°` : `+${degrees}°`;
}

export function straightenLabel(degrees: number): string {
  return `Straighten ${signedDegrees(degrees)}`;
}

export function totalRotation(quarters: number, straighten: number): number {
  return (((quarters % 4) + 4) % 4) * 90 + straighten;
}

export function rotatedBox(
  width: number,
  height: number,
  degrees: number
): { width: number; height: number } {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    height: width * sin + height * cos,
    width: width * cos + height * sin,
  };
}

export function rotatedFrameRatio(assetRatio: number, degrees: number): number {
  const box = rotatedBox(assetRatio, 1, degrees);
  return box.height > 0 ? box.width / box.height : assetRatio;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: CropRect = { h: 1, w: 1, x: 0, y: 0 };

export const MIN_CROP = 0.1;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function clampCrop(rect: CropRect): CropRect {
  const w = clamp(rect.w, MIN_CROP, 1);
  const h = clamp(rect.h, MIN_CROP, 1);
  return { h, w, x: clamp(rect.x, 0, 1 - w), y: clamp(rect.y, 0, 1 - h) };
}

export function moveCrop(rect: CropRect, dx: number, dy: number): CropRect {
  return clampCrop({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

export function scaleCrop(rect: CropRect, factor: number): CropRect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const w = clamp(rect.w * factor, MIN_CROP, 1);
  const h = clamp(rect.h * factor, MIN_CROP, 1);
  return clampCrop({ h, w, x: cx - w / 2, y: cy - h / 2 });
}

export const EDITOR_RATIOS = ["Original", "Square", "3 : 2"] as const;
export type EditorRatio = (typeof EDITOR_RATIOS)[number];

export function ratioValue(ratio: EditorRatio): number | null {
  if (ratio === "Square") return 1;
  if (ratio === "3 : 2") return 3 / 2;
  return null;
}

export function centredCrop(frameRatio: number, ratio: number): CropRect {
  if (ratio >= frameRatio) {
    const h = frameRatio / ratio;
    return { h, w: 1, x: 0, y: (1 - h) / 2 };
  }
  const w = ratio / frameRatio;
  return { h: 1, w, x: (1 - w) / 2, y: 0 };
}

export function cropPixels(
  rect: CropRect,
  frame: { width: number; height: number }
): { originX: number; originY: number; width: number; height: number } {
  const width = Math.max(1, Math.round(rect.w * frame.width));
  const height = Math.max(1, Math.round(rect.h * frame.height));
  return {
    height: Math.min(height, frame.height),
    originX: clamp(
      Math.round(rect.x * frame.width),
      0,
      Math.max(0, frame.width - width)
    ),
    originY: clamp(
      Math.round(rect.y * frame.height),
      0,
      Math.max(0, frame.height - height)
    ),
    width: Math.min(width, frame.width),
  };
}

export type FlipAxis = "horizontal" | "vertical" | undefined;

export function nextFlip(current: FlipAxis): FlipAxis {
  if (current === undefined) return "horizontal";
  if (current === "horizontal") return "vertical";
  return undefined;
}

export function flipLabel(flip: FlipAxis): string {
  if (flip === "horizontal") return "Flip ↔";
  if (flip === "vertical") return "Flip ↕";
  return "Flip";
}

export function editorStatus(input: {
  ratio: EditorRatio;
  quarters: number;
  straighten: number;
  flip?: FlipAxis;
}): string {
  const rotation = totalRotation(input.quarters, input.straighten);
  const flipClause = input.flip
    ? ` · ${flipLabel(input.flip).toLowerCase()}`
    : "";
  return `Crop ${input.ratio} · rotation ${signedDegrees(rotation)}${flipClause} · nothing written yet`;
}

export function isEdited(input: {
  ratio: EditorRatio;
  quarters: number;
  straighten: number;
  crop: CropRect;
  flip?: FlipAxis;
}): boolean {
  return (
    input.ratio !== "Original" ||
    totalRotation(input.quarters, input.straighten) !== 0 ||
    input.crop.x !== FULL_CROP.x ||
    input.crop.y !== FULL_CROP.y ||
    input.crop.w !== FULL_CROP.w ||
    input.crop.h !== FULL_CROP.h ||
    input.flip !== undefined
  );
}

export function editedFilename(sourceName: string | undefined): string {
  const base = (sourceName ?? "photograph").replace(/\.[a-z0-9]+$/iu, "");
  return `${base || "photograph"}-edited.jpg`;
}
