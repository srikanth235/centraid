/**
 * THE CAPTURE-TIME OCR CONSENT MOMENT (#712) — the second instance
 * of the §8 consent gate, after Photos' face detection
 * (`apps/photos/enrichment-consent.ts`).
 *
 * `apps/mobile/src/screens/Scan.tsx` must not run text extraction
 * UNCONDITIONALLY at capture: device `recognizeText` first, then — silently,
 * on failure — a gateway HTTP fallback (`POST …/capture/ocr`). Without a
 * consent moment a member never chooses whether their scan's bytes may leave
 * the phone, because until the device engine fails they never do, and the
 * panel that would say so never renders either way. This module supplies the
 * copy for the latch that closes that gap
 * (`apps/mobile/src/screens/scan-consent.ts`).
 *
 * Copy lives here (`apps/_shared/`) rather than under a `docs` blueprint app
 * because Scan.tsx is a FRAME surface, not Docs' own: the same capture feeds
 * Tally receipts, Docs scans, Photos originals and Locker cards, and only
 * one of those four destinations is Docs.
 *
 * THE TWO REAL LANES, per the #630 Local OCR decision (docs/decisions.md)
 * and the C5 trust-domain doctrine (docs/blueprint-seats.md): device-native
 * first (iOS Vision / Android ML Kit — "No image or recognized text leaves
 * the user's devices"), then a BOUNDED gateway backstop, capped at 20
 * megapixels / 25 MiB, used only when the device engine is unavailable. The
 * backstop is the member's OWN gateway, never a third-party provider — so
 * unlike Photos' cloud panel, it is not a second thing to choose; it is
 * disclosed, not offered, and the on-device answer covers both lanes.
 */

import type { ConsentPanelCopy } from "./consent-gate.ts";

/** Panel A — the device. Nothing leaves; covers both lanes below. */
export const OCR_ON_DEVICE_PANEL: ConsentPanelCopy = {
  eyebrow: "Consent",
  title: "Extract text from this scan?",
  body: "Text extraction reads the words on the page so a scan can be found by search and, for a receipt, split automatically. It never changes the image you captured, and it runs once, right after you take or choose it.",
  facts: [
    { label: "where it would run", value: "on this phone" },
    { label: "what leaves the device", value: "nothing" },
    { label: "how long", value: "a few seconds" },
    { label: "what it writes", value: "the extracted text, beside the scan" },
    {
      label: "undo",
      value: "decline — the scan still saves, without extracted text",
    },
  ],
  action: "Extract on this phone",
  action2: "Not now",
  filled: true,
};

/**
 * Panel B — the gateway backstop. THE DISCLOSURE PANEL, for the one lane
 * that is not a separate choice: `net.available` is always `false` here (see
 * `scan-consent.ts`), with the reason stating that plainly, because the
 * point of this panel is the disclosure, not an action to take.
 */
export const OCR_GATEWAY_PANEL: ConsentPanelCopy = {
  eyebrow: "The backstop",
  net: true,
  title: "The gateway backstop",
  body: "Used automatically, only when on-device extraction cannot run on this phone. The image goes to your own gateway and nowhere else — never a third-party provider — capped in size so a single scan cannot overwhelm it.",
  facts: [
    {
      label: "where it would run",
      value: "your gateway, only if the device engine is unavailable",
    },
    {
      label: "what leaves the device",
      value: "the scan image, to your gateway only",
      net: true,
    },
    { label: "size caps", value: "up to 20 megapixels or 25 MiB per scan" },
    {
      label: "a separate choice",
      value: "no — covered by the on-device answer",
    },
  ],
  action: "Not a separate choice",
};

/** Why the backstop panel's action is never available from here — it is a
 *  disclosure, not a control (mirrors `ENRICHMENT_UNAVAILABLE.cloudUnavailable`
 *  in `apps/photos/enrichment-consent.ts`). */
export const OCR_GATEWAY_NOT_A_CHOICE =
  "Not a separate choice: the gateway backstop runs automatically, only when on-device extraction can't. Answering the on-device question above covers both.";

/** The note under both panels — declining is a real answer, not a dead end. */
export const OCR_CONSENT_NOTE =
  "Declining saves the scan without extracted text, stated on the scan itself — search and receipt-splitting need the text, but nothing else about saving changes.";

/** What the scan screen says once extraction was declined, beside the scan —
 *  never a dead control (#712). */
export const OCR_DECLINED_INLINE =
  "Text extraction declined — this scan saves without extracted text.";
