// Capture-time OCR consent latch (#712), mirroring the transfer-consent backup
// latch: per device, remembered, revocable. Scan.tsx reaches `extract()` only
// through this gate; `undefined` refuses like `"not-now"` — unanswered is not yes.
// Per device on purpose: vault sync would inherit an answer never asked.
import { Store } from "../storage";

/** Member-device state, never vault state. */
export const SCAN_OCR_CONSENT_KEY = "frame.scanOcrConsent";

export type ScanOcrConsentAnswer = "on-device" | "not-now";

export interface ScanOcrConsentRecord {
  answer: ScanOcrConsentAnswer;
  /** Shown back to the member; never a gate. */
  at: string;
}

export async function hydrateScanOcrConsent(): Promise<
  ScanOcrConsentRecord | undefined
> {
  return Store.hydrate<ScanOcrConsentRecord | undefined>(
    SCAN_OCR_CONSENT_KEY,
    undefined
  );
}

export function answerScanOcrConsent(
  answer: ScanOcrConsentAnswer
): ScanOcrConsentRecord {
  const record: ScanOcrConsentRecord = { answer, at: new Date().toISOString() };
  Store.set(SCAN_OCR_CONSENT_KEY, record);
  return record;
}

/**
 * THE GATE: `extract()` in Scan.tsx is reachable only when this returns true;
 * `undefined` is refused exactly as `"not-now"` is.
 */
export function scanOcrExtractionAllowed(
  consent: ScanOcrConsentRecord | undefined
): boolean {
  return consent?.answer === "on-device";
}
