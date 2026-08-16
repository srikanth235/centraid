/** Stable app ids for the bundled recognition recipes shipped by Centraid. */
export const SYSTEM_RECOGNITION_TEMPLATE_IDS = [
  "photo-ocr",
  "transcript",
  "embed-image",
  "embed-text",
  "faces",
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
