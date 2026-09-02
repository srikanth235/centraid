/**
 * Membership makes a recipe SYSTEM-MANAGED: ids are reserved against member
 * code (`build-gateway.ts`'s `isBundledAppId`), Automations renders them as an
 * owner-controlled toggle, and the scheduler reconcile filters these rows on
 * `row.enabled`, not the experimental-automations gate — so an off-by-default
 * recipe here (`place-names`, #816) opts in per member without bypassing the gate.
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

export function isSystemRecognitionRef(ref: string | undefined): boolean {
  return ref !== undefined && systemRecognitionRefs.has(ref);
}
