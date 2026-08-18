/**
 * Stable app ids for the bundled recognition recipes shipped by Centraid.
 *
 * Membership here is what makes a recipe SYSTEM-MANAGED: its id is reserved
 * against member code (`build-gateway.ts`'s `isBundledAppId`), Automations
 * renders it as an owner-controlled toggle rather than an editable automation,
 * and — the part that matters for an off-by-default recipe — the scheduler
 * reconcile filters these rows on `row.enabled` instead of on the experimental
 * automations gate. So a system recognition recipe shipping `enabled: false`
 * (`place-names`, issue #816) holds no scheduler registration and bootstraps no
 * data cursor until a member turns it on, while the always-on recipes keep the
 * photos pipeline flowing regardless of that gate. Being listed here is
 * therefore the correct home for an opt-in recipe, not a bypass of the opt-in.
 */
export const SYSTEM_RECOGNITION_TEMPLATE_IDS = [
  "photo-ocr",
  "transcript",
  "embed-image",
  "embed-text",
  "faces",
  "place-names",
] as const;

/** The capture surface enters the exact same recipe as background photo OCR. */
export const SYSTEM_CAPTURE_OCR_REF = "photo-ocr/photo-ocr";

/** `<id>/<id>` refs for every bundled recognition recipe — the "recognition" system lane. */
export const SYSTEM_RECOGNITION_REFS: readonly string[] =
  SYSTEM_RECOGNITION_TEMPLATE_IDS.map((id) => `${id}/${id}`);

const systemRecognitionRefs = new Set<string>(SYSTEM_RECOGNITION_REFS);

/** True for a run owned by one of Centraid's built-in recognition recipes. */
export function isSystemRecognitionRef(ref: string | undefined): boolean {
  return ref !== undefined && systemRecognitionRefs.has(ref);
}
