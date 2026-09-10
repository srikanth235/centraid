/**
 * Provenance tiers for the bundled automations Centraid ships.
 *
 * "System" is a PROVENANCE TIER, not a capability request and not a manifest
 * field: shipped with the release, first-party code authored in this repo,
 * present in every vault, upgraded with the release, on by default, and
 * executed with the same trust as the rest of `packages/server`. Membership is
 * a constant in this file, read at load time — never anything a handler or a
 * manifest declares. `build-gateway.ts` reserves every id below against
 * code-store apps (`isBundledAppId`), so a member app can never shadow one and
 * inherit its tier.
 *
 * Three tiers, and the difference between them is where the code came from:
 *
 *  - SYSTEM (`SYSTEM_AUTOMATION_IDS`) — first-party recognition the photos and
 *    documents pipelines *are*. Always armed from the catalogue on every boot;
 *    no `enabled` flag is consulted (see `build-gateway.ts`), and the handler
 *    runs in the `system` sandbox lane, which grants nothing the gateway
 *    process does not already have.
 *  - BUNDLED-OPTIONAL (`BUNDLED_OPTIONAL_AUTOMATION_IDS`) — shipped in the
 *    release but off until the member turns them on. Today's `enabled`
 *    semantics, today's sandbox lanes, unchanged.
 *  - EXTERNAL — code-store automations, future. Not in this file at all; the
 *    sandbox in `engine/sandbox/*` is their boundary and stays exactly as
 *    strict as it is today.
 */

/** First-party system automations: always on, `system` sandbox lane. */
export const SYSTEM_AUTOMATION_IDS = [
  "faces",
  "photo-ocr",
  "doc-text-extractor",
] as const;

/** Bundled with the release, off until the member turns them on. Sandboxed
 *  exactly as they are today — the `system` lane is not reachable from here. */
export const BUNDLED_OPTIONAL_AUTOMATION_IDS = [
  "embed-image",
  "embed-text",
  "transcript",
  "place-names",
] as const;

/**
 * Every bundled automation the release manages, either tier. This is the id
 * RESERVATION set (`isBundledAppId`) and the set Automations renders as
 * owner-controlled rather than editable — it says "we ship this", never "this
 * is trusted".
 */
export const SYSTEM_RECOGNITION_TEMPLATE_IDS: readonly string[] = Object.freeze(
  [...SYSTEM_AUTOMATION_IDS, ...BUNDLED_OPTIONAL_AUTOMATION_IDS]
);

/** The capture surface enters the exact same recipe as background photo OCR. */
export const SYSTEM_CAPTURE_OCR_REF = "photo-ocr/photo-ocr";

/** `<id>/<id>` refs for every bundled recipe, either tier. */
export const SYSTEM_RECOGNITION_REFS: readonly string[] =
  SYSTEM_RECOGNITION_TEMPLATE_IDS.map((id) => `${id}/${id}`);

/** `<id>/<id>` refs for the system tier alone. */
export const SYSTEM_AUTOMATION_REFS: readonly string[] =
  SYSTEM_AUTOMATION_IDS.map((id) => `${id}/${id}`);

const systemRecognitionRefs = new Set<string>(SYSTEM_RECOGNITION_REFS);
const systemAutomationRefs = new Set<string>(SYSTEM_AUTOMATION_REFS);
const systemAutomationIds = new Set<string>(SYSTEM_AUTOMATION_IDS);

/** True for a run owned by any bundled recipe — either tier. */
export function isSystemRecognitionRef(ref: string | undefined): boolean {
  return ref !== undefined && systemRecognitionRefs.has(ref);
}

/**
 * True for a run owned by a first-party SYSTEM automation. The one predicate
 * that routes a handler to the `system` sandbox lane and arms it unconditionally
 * — keep it keyed on the constant above and nothing else.
 */
export function isSystemAutomationRef(ref: string | undefined): boolean {
  return ref !== undefined && systemAutomationRefs.has(ref);
}

/** Id form of `isSystemAutomationRef`, for the install and scheduler seams. */
export function isSystemAutomationId(id: string | undefined): boolean {
  return id !== undefined && systemAutomationIds.has(id);
}
