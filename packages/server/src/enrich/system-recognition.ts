export const SYSTEM_RECOGNITION_TEMPLATE_IDS = [
  "photo-ocr",
  "transcript",
  "embed-image",
  "embed-text",
  "faces",
  "place-names",
] as const;

export const SYSTEM_CAPTURE_OCR_REF = "photo-ocr/photo-ocr";

export const SYSTEM_RECOGNITION_REFS: readonly string[] =
  SYSTEM_RECOGNITION_TEMPLATE_IDS.map((id) => `${id}/${id}`);

const systemRecognitionRefs = new Set<string>(SYSTEM_RECOGNITION_REFS);

export function isSystemRecognitionRef(ref: string | undefined): boolean {
  return ref !== undefined && systemRecognitionRefs.has(ref);
}
