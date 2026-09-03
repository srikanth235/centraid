import { Store } from "../storage";

export const SCAN_OCR_CONSENT_KEY = "frame.scanOcrConsent";

export type ScanOcrConsentAnswer = "on-device" | "not-now";

export interface ScanOcrConsentRecord {
  answer: ScanOcrConsentAnswer;
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

export function scanOcrExtractionAllowed(
  consent: ScanOcrConsentRecord | undefined
): boolean {
  return consent?.answer === "on-device";
}
