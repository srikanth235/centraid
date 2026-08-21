import { ConsentGate } from "../../_shared/ConsentGate.tsx";
// THE ENRICHMENT CONSENT SURFACE (v4 handoff §8, prototype `s==='enrich'`).
//
// A THIN WRAPPER (issue #712 C1): the two-panel renderer itself lifted to
// `apps/_shared/ConsentGate.tsx` so Docs' capture-time OCR consent (the
// second instance of this product law) reads the same component. This file
// now only supplies Photos' own copy (`../enrichment-consent.ts`) and props
// — the panels, facts, `--net` border, and "one filled element" rule (§18)
// all live in the shared gate, unchanged.
//
// A PURE VIEW, same as before: it holds no state, reads nothing, and writes
// nothing — every answer leaves through a callback. The gate itself (the ONE
// call site that may fire `request-enrichment`) lives in Enrichment.tsx.
import {
  CLOUD_PANEL,
  ENRICHMENT_NOTE,
  ON_DEVICE_PANEL,
  onDeviceTitle,
} from "../enrichment-consent.ts";
import type { AnswerAvailability } from "../enrichment-consent.ts";

export interface EnrichmentConsentProps {
  /** How many photographs the question is about. `null` while the library
   *  count is unknown — the title then asks about "these photographs" rather
   *  than inventing a number. */
  count: number | null;
  onDevice: AnswerAvailability;
  cloud: AnswerAvailability;
  /** A write is in flight. Both answers go unavailable — an answered question
   *  is not re-answerable by a double click. */
  busy?: boolean;
  /** Set once the member has answered, so the surface stops offering the
   *  question it has already been given an answer to. */
  answered?: "device" | "declined" | null;
  onRunOnDevice: () => void;
  onDecline: () => void;
  /** Absent while no cloud helper can be chosen — see the header. */
  onChooseCloud?: () => void;
}

export function EnrichmentConsent({
  count,
  onDevice,
  cloud,
  busy,
  answered,
  onRunOnDevice,
  onDecline,
  onChooseCloud,
}: EnrichmentConsentProps) {
  return (
    <ConsentGate
      domain="photos"
      onDevicePanel={ON_DEVICE_PANEL}
      onDeviceTitle={count == null ? undefined : onDeviceTitle(count)}
      onDevice={onDevice}
      netPanel={CLOUD_PANEL}
      net={cloud}
      note={ENRICHMENT_NOTE}
      busy={busy}
      answered={answered}
      onRunOnDevice={onRunOnDevice}
      onDecline={onDecline}
      onChooseNet={onChooseCloud}
    />
  );
}
