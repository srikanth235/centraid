// THE CAPTURE-TIME OCR CONSENT LATCH (issue #712 C3) — the second instance
// of the frame's per-device consent moment, mirroring
// `kit/transfer/transfer-consent.ts`'s BACKUP latch: asked once per device,
// remembered, revocable.
//
// `Scan.tsx` must not call `extract()` unconditionally when a photograph is
// captured or chosen — device `recognizeText` first, then, silently on
// failure, a gateway HTTP fallback — because that leaves a member no moment to
// choose whether their scan's bytes may leave the phone. This latch IS that
// moment. `undefined` (never asked) refuses extraction exactly as
// `"not-now"` does — an unanswered question is not a yes, the same rule
// `automaticTransferAllowed` holds for backup.
//
// PER DEVICE, deliberately, same reasoning as the backup latch: "may this
// phone extract text from what it scans" has one answer per device, and
// syncing it through the vault would have a new phone inherit an answer it
// was never asked.
import { Store } from "../storage";

/** Member-device state, not vault state — see the header. */
export const SCAN_OCR_CONSENT_KEY = "frame.scanOcrConsent";

export type ScanOcrConsentAnswer = "on-device" | "not-now";

export interface ScanOcrConsentRecord {
  answer: ScanOcrConsentAnswer;
  /** When it was answered. Shown back to the member; never used as a gate. */
  at: string;
}

/** Read the latch. `undefined` means the question has not been asked yet. */
export async function hydrateScanOcrConsent(): Promise<
  ScanOcrConsentRecord | undefined
> {
  return Store.hydrate<ScanOcrConsentRecord | undefined>(
    SCAN_OCR_CONSENT_KEY,
    undefined
  );
}

/** Record an answer and hand it back, so a caller can hold it in state.
 *  Callable again later with either answer — the latch is revocable. */
export function answerScanOcrConsent(
  answer: ScanOcrConsentAnswer
): ScanOcrConsentRecord {
  const record: ScanOcrConsentRecord = { answer, at: new Date().toISOString() };
  Store.set(SCAN_OCR_CONSENT_KEY, record);
  return record;
}

/**
 * THE GATE. `extract()` in Scan.tsx is reachable only when this is true.
 * `undefined` — a device that has never seen the panel — is refused exactly
 * as `"not-now"` is: asked once, not assumed once.
 */
export function scanOcrExtractionAllowed(
  consent: ScanOcrConsentRecord | undefined
): boolean {
  return consent?.answer === "on-device";
}
