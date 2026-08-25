// Capture-time OCR consent (#712). Scan.tsx must not extract text UNCONDITIONALLY: device first, then gateway `POST …/capture/ocr`. Copy lives in `_shared/` because Scan is a FRAME surface, not Docs'. Gateway backstop is disclosed, not offered — the on-device answer covers both lanes (#630).

import type { ConsentPanelCopy } from "./consent-gate.ts";

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

/** Disclosure only — `net.available` is always false here (`scan-consent.ts`); not an action. */
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

/** Disclosure, not a control (mirrors `ENRICHMENT_UNAVAILABLE.cloudUnavailable`). */
export const OCR_GATEWAY_NOT_A_CHOICE =
  "Not a separate choice: the gateway backstop runs automatically, only when on-device extraction can't. Answering the on-device question above covers both.";

export const OCR_CONSENT_NOTE =
  "Declining saves the scan without extracted text, stated on the scan itself — search and receipt-splitting need the text, but nothing else about saving changes.";

export const OCR_DECLINED_INLINE =
  "Text extraction declined — this scan saves without extracted text.";
