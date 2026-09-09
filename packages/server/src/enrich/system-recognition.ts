/**
 * Stable app ids for the bundled recognition recipes shipped by Centraid.
 *
 * Membership here is what makes a recipe SYSTEM-MANAGED: its id is reserved
 * against member code (`build-gateway.ts`'s `isBundledAppId`), Automations
 * renders it as an owner-controlled toggle rather than an editable automation,
 * and the scheduler reconcile filters these rows on `row.enabled` instead of
 * on the experimental automations gate.
 *
 * Every recipe listed here ships `enabled: true` and fires on media ingest
 * (ruled 2026-09-09; see docs/decisions.md). `faces` is deliberately included:
 * face detection is opt-OUT — through this recipe's own toggle under
 * Automations → Recognition, or vault-wide through the `enrich_policy` tier's
 * `off` — never opt-in behind a consent sheet. So the `row.enabled` filter is
 * the opt-OUT mechanism, not an opt-in one: a member who turns a recipe off
 * drops its scheduler registration and its data cursor, while install
 * preserves an existing row's own `enabled` bit so that answer survives every
 * upgrade.
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
