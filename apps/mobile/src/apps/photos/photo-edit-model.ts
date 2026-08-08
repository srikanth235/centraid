// What the phone's editor IS, as data — separate from what draws it (v4
// handoff §7.4, prototype `photoStage()` edit branch).
//
// Crop and rotate only, and NON-DESTRUCTIVE: the whole point of this surface is
// that nothing is written until `Save as a new photograph` is pressed, and that
// what it then writes is a NEW photograph beside the original. Every number the
// editor needs to answer "what would be written" lives here rather than inside
// a component, so the promise can be asserted without rendering React Native —
// the same reason `viewer-model.ts` exists (§7, CHANGELOG §D).
//
// The member-facing COPY is imported from the blueprint the web editor renders
// rather than retyped. A member who crops on the desktop and crops on the phone
// must be given the same promise, word for word; two string literals in two
// packages is exactly how that stops being true.
//
// FLIP joined crop/rotate/straighten in the same tool row (issue #724 B1) for
// the same reason rotate did: `expo-image-manipulator`'s manipulator context
// exposes it directly (`.flip('horizontal')`), so it costs nothing beyond a
// toggle here and a chained call in `photo-edit-save.ts`.
//
// AUTO-ENHANCE IS DELIBERATELY ABSENT. A curve/levels heuristic needs the
// photograph's own pixel buffer to compute a histogram over, and neither
// `expo-image-manipulator` (crop/rotate/flip/resize/extent only — see its own
// `Action` union) nor anything else already in this app's dependency tree
// hands React Native a decoded RGBA buffer without adding a native module.
// `generateDeviceDerivatives` (`lib/upload/derivatives-native.ts`) DOES decode
// pixels — through `jpeg-js`, for the thumbhash/phash pipeline — but only for
// its own small thumbnail rung, and reusing that decode for a full-resolution
// "enhance" would mean re-implementing curve stretching over raw bytes on the
// JS thread for a 12MP photograph, which is not what "reuse what already
// exists" means. So this editor ships the adjustments it can make honestly
// (crop, rotate, straighten, flip) and stops there rather than shipping a
// fake "Enhance" button that silently does nothing, or a real one that would
// require the native dependency this issue's brief forbids adding.

// The commit and its explanation, WORD FOR WORD as the web editor renders them
// (`packages/blueprints/apps/photos/viewer.ts`). They are re-declared here
// rather than imported because that module reaches its neighbours through
// `.ts`-suffixed specifiers, which the Expo tsconfig rejects — importing it
// from this app turns 0 type errors into 13. `photo-edit-model.test.ts` pins
// the strings so a silent drift is still caught; lifting them into a leaf
// module both packages can import is the real fix, and is reported upstream.
export const SAVE_AS_NEW = "Save as a new photograph";
export const SAVE_AS_NEW_EXPLANATION =
  "Saving writes a new photograph dated today, with this one recorded as its source. The original is not touched, and nothing is overwritten.";

/** The top bar's title while editing — it replaces the photograph's caption. */
export const EDITOR_TITLE = "Crop and rotate";

/** `Cancel` sits beside the commit; it is the only way out that writes nothing
 *  AND the only way out at all, since the editor suppresses the viewer's own
 *  chrome while it is open. */
export const EDITOR_CANCEL = "Cancel";

/**
 * The meta line under the title while editing: `from a photograph taken 30
 * July 2026`. It names the SOURCE, because the thing being edited is not the
 * thing that will be saved — that distinction is the editor's whole argument.
 */
export function editorMeta(capturedAt?: string): string {
  const when = capturedAt ? new Date(capturedAt) : undefined;
  if (!when || Number.isNaN(when.getTime())) return "from a photograph";
  return `from a photograph taken ${when.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  })}`;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/** How far one press of Straighten turns the frame, and how far it may go.
 *  Matched to the web editor's constants: this control is for levelling a
 *  horizon, not for rotating a photograph — `Rotate 90°` is for that. */
export const STRAIGHTEN_STEP = 1;
export const STRAIGHTEN_LIMIT = 15;

/**
 * The phone carries ONE straighten control (prototype line 4621), not the
 * desktop's − / readout / + trio: a 390px tool row that already wraps cannot
 * afford three targets for one number, and the proto's row is binding.
 *
 * So the single button is both the readout and the step: each press levels one
 * more degree anticlockwise, and the press after the limit returns the frame to
 * level rather than dead-ending. The cost is that the phone cannot straighten
 * CLOCKWISE, which the desktop can — recorded rather than hidden, and the
 * reason the range is not symmetric here.
 */
export function nextStraighten(degrees: number): number {
  const next = degrees - STRAIGHTEN_STEP;
  return next < -STRAIGHTEN_LIMIT ? 0 : next;
}

/** A signed angle in the member's register: `−2°`, `+3°`, `0°`. The minus is
 *  U+2212, not a hyphen — this is a number, and it reads in the mono role. */
export function signedDegrees(degrees: number): string {
  if (degrees === 0) return "0°";
  return degrees < 0 ? `−${Math.abs(degrees)}°` : `+${degrees}°`;
}

/** The one button's label, carrying the live angle (proto 4621). */
export function straightenLabel(degrees: number): string {
  return `Straighten ${signedDegrees(degrees)}`;
}

/** Quarter turns plus levelling — the ONE angle the render pipeline applies. */
export function totalRotation(quarters: number, straighten: number): number {
  return (((quarters % 4) + 4) % 4) * 90 + straighten;
}

/**
 * The bounding box a `width × height` frame occupies once turned by `degrees`.
 * Straighten is not a multiple of 90°, so the box GROWS rather than merely
 * swapping its sides — and the crop rectangle is expressed in fractions of that
 * grown box, which is why the preview and the saved bytes agree.
 */
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

/** The aspect ratio of that box — what "the frame" means at this rotation. */
export function rotatedFrameRatio(assetRatio: number, degrees: number): number {
  const box = rotatedBox(assetRatio, 1, degrees);
  return box.height > 0 ? box.width / box.height : assetRatio;
}

// ---------------------------------------------------------------------------
// The crop rectangle
// ---------------------------------------------------------------------------

/** In FRACTIONS of the current (rotated) frame, so it survives a resize and
 *  means the same thing on the stage and in the saved pixels. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: CropRect = { h: 1, w: 1, x: 0, y: 0 };

/** Below this the box stops being a crop and starts being a mis-tap. */
export const MIN_CROP = 0.1;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** A rectangle that is inside the frame, and big enough to see. */
export function clampCrop(rect: CropRect): CropRect {
  const w = clamp(rect.w, MIN_CROP, 1);
  const h = clamp(rect.h, MIN_CROP, 1);
  return { h, w, x: clamp(rect.x, 0, 1 - w), y: clamp(rect.y, 0, 1 - h) };
}

/** Drag: the box moves, its size never changes — a drag that resized the crop
 *  would silently change the ratio the member chose. */
export function moveCrop(rect: CropRect, dx: number, dy: number): CropRect {
  return clampCrop({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/**
 * Pinch: the box grows or shrinks about its own centre, KEEPING its aspect in
 * frame terms so a `3 : 2` crop is still `3 : 2` afterwards. Deliberately not a
 * free-form eight-handle resize — this is the Google Photos gesture, not a
 * gesture engine (issue #711).
 */
export function scaleCrop(rect: CropRect, factor: number): CropRect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const w = clamp(rect.w * factor, MIN_CROP, 1);
  const h = clamp(rect.h * factor, MIN_CROP, 1);
  return clampCrop({ h, w, x: cx - w / 2, y: cy - h / 2 });
}

/** The named ratios, in the proto's order and the proto's SPACING — `3 : 2`
 *  with spaces, because it renders in the mono role (proto 4621, 4624). */
export const EDITOR_RATIOS = ["Original", "Square", "3 : 2"] as const;
export type EditorRatio = (typeof EDITOR_RATIOS)[number];

/** A named ratio as a number, or null for "whatever the frame already is". */
export function ratioValue(ratio: EditorRatio): number | null {
  if (ratio === "Square") return 1;
  if (ratio === "3 : 2") return 3 / 2;
  return null;
}

/** The largest centred crop of `ratio` that fits a frame of `frameRatio`, in
 *  fractions of that frame — the geometry `Square` and `3 : 2` snap to. */
export function centredCrop(frameRatio: number, ratio: number): CropRect {
  if (ratio >= frameRatio) {
    const h = frameRatio / ratio;
    return { h, w: 1, x: 0, y: (1 - h) / 2 };
  }
  const w = ratio / frameRatio;
  return { h: 1, w, x: (1 - w) / 2, y: 0 };
}

/** The crop as whole pixels of a rendered frame — what the native manipulator
 *  is handed. Rounded and clamped so a rounding error can never ask for a
 *  rectangle that runs off the edge of the bitmap. */
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

// ---------------------------------------------------------------------------
// What the editor is about to do, in one sentence
// ---------------------------------------------------------------------------

/** Horizontal is the mirror a member actually wants (a selfie shot the way it
 *  faced the lens); vertical is offered for parity with the manipulator's own
 *  two-axis support rather than because it is commonly asked for. `undefined`
 *  is "no flip" — the third state a boolean cannot hold on its own, and the
 *  one an untouched editor must be in. */
export type FlipAxis = "horizontal" | "vertical" | undefined;

/** One press: no flip → horizontal → vertical → no flip. Only one axis at a
 *  time (the manipulator's own constraint — "one flip per transformation"),
 *  so this is a three-way cycle, not two independent toggles. */
export function nextFlip(current: FlipAxis): FlipAxis {
  if (current === undefined) return "horizontal";
  if (current === "horizontal") return "vertical";
  return undefined;
}

/** The flip tool's own label, carrying the live axis so the row reads the
 *  same way `straightenLabel` does. */
export function flipLabel(flip: FlipAxis): string {
  if (flip === "horizontal") return "Flip ↔";
  if (flip === "vertical") return "Flip ↕";
  return "Flip";
}

/**
 * The stage's status line while editing (proto 4632–4645):
 * `Crop 3 : 2 · rotation −2° · nothing written yet`.
 *
 * The last clause is the load-bearing one, and it is a FACT about this module's
 * state rather than reassurance: while the editor is open nothing has been
 * staged, uploaded or journalled, and `editorStatus` is the sentence that says
 * so at every moment the member could be wondering.
 */
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

/** Whether anything would actually change — `Reset` and the commit both need
 *  to know, and neither may guess. */
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

/** The filename the new photograph carries. `-edited` rather than a fresh
 *  opaque id, so the member can find it by name — the same suffix the web
 *  editor writes, so one library does not sort into two conventions. */
export function editedFilename(sourceName: string | undefined): string {
  const base = (sourceName ?? "photograph").replace(/\.[a-z0-9]+$/iu, "");
  return `${base || "photograph"}-edited.jpg`;
}
