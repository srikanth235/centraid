// The capture route's OCR adapter (issue #724 W4 capture-route rewire):
// screenshot/quick-capture OCR now asks the SAME enrichment service the
// background sweep does (`enrich/ocr-sweep.ts`), instead of spawning a
// locally-installed Tesseract binary — one seam, one operator knob
// (`CENTRAID_ENRICH_URL`), one wire contract to stay honest about "not
// configured" versus "the model does not see anything here."
//
// SINGLE ITEM, LOW LATENCY. A capture is a paste-and-go gesture — the member
// is waiting on this HTTP call, so it goes straight to `enrichBatch` with
// exactly one item rather than joining the background sweep's queue. The
// sweep and this route share the wire contract and the reading-order rule;
// they never share a schedule.
//
// THE 503 CONTRACT IS UNCHANGED, ONLY ITS NAME. Before this rewire, no
// configured Tesseract executable meant "OCR is not configured on this
// gateway" — an honest 503, never a silent upload to a third party. The same honest
// refusal now names the enrichment service instead: no `CENTRAID_ENRICH_URL`
// configured, no service advertising `ocr`, or a service that times out all
// surface as the identical `ocr_unavailable` the route already answered
// with — `capture-routes.ts` did not have to change its refusal shape at
// all, only what feeds it.

import {
  ENRICH_UNCONFIGURED_REASON,
  enrichBatch,
  isEnrichFailure,
  ocrReadingOrderText,
} from "../enrich/service-client.js";
import type {
  EnrichCallOptions,
  EnrichServiceConfig,
} from "../enrich/service-client.js";

export interface OcrExtraction {
  text: string;
  confidence: number;
  engine: "enrichment-service";
}

/** A single-item batch never reuses its id; the value itself is arbitrary. */
const CAPTURE_ITEM_ID = "capture";

/** The service scores per-region; a capture wants one number for the whole
 * image, so this averages what it returned rather than inventing a score. */
function averageConfidence(regions: readonly { confidence: number }[]): number {
  if (regions.length === 0) return 0;
  return (
    regions.reduce((sum, region) => sum + region.confidence, 0) / regions.length
  );
}

/**
 * Build the capture route's `recognizeOcr` function over a configured
 * enrichment service. `config` is read once at gateway start, the same as
 * every other enrichment consumer — a service that goes away mid-process is
 * exactly the "unavailable" case `enrichBatch` already turns into a thrown
 * error here, which `capture-routes.ts` turns into the honest 503.
 */
export function makeCaptureOcrRecognizer(
  config: EnrichServiceConfig | null,
  options: EnrichCallOptions = {}
): (input: Buffer, mediaType: string) => Promise<OcrExtraction> {
  return async (input: Buffer, mediaType: string): Promise<OcrExtraction> => {
    if (!config) {
      throw new Error(
        `Gateway OCR is not configured. ${ENRICH_UNCONFIGURED_REASON}.`
      );
    }
    const outcome = await enrichBatch(
      config,
      "ocr",
      [{ id: CAPTURE_ITEM_ID, mediaType, bytes: input.toString("base64") }],
      options
    );
    if (outcome.status === "unavailable")
      throw new Error(`Gateway OCR is not available: ${outcome.reason}`);
    const result = outcome.results[0];
    if (!result) throw new Error("Gateway OCR returned no result.");
    if (isEnrichFailure(result)) throw new Error(result.error);
    return {
      text: ocrReadingOrderText(result.regions),
      confidence: averageConfidence(result.regions),
      engine: "enrichment-service",
    };
  };
}
