// The capture route's OCR adapter. Capture is deliberately not a second
// recognition implementation: it invokes and awaits the stable Photo OCR
// automation. Its generated handler owns model loading and inference; the
// route keeps its honest 503 refusal shape when policy or model assets refuse.

import { SYSTEM_CAPTURE_OCR_REF } from "../enrich/system-recognition.js";

export interface OcrExtraction {
  text: string;
  confidence?: number;
  engine: "automation";
}

export interface CaptureAutomationOutcome {
  ok: boolean;
  skipped?: boolean;
  output?: unknown;
  error?: string;
}

export type CaptureAutomationInvoker = (
  automationRef: string,
  input: unknown
) => Promise<{ outcome?: CaptureAutomationOutcome }>;

function extractionFrom(output: unknown): OcrExtraction {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Photo OCR returned no capture result.");
  }
  const row = output as Record<string, unknown>;
  if (typeof row.text !== "string") {
    throw new Error("Photo OCR returned an invalid capture result.");
  }
  const confidence = row.confidence;
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" || confidence < 0 || confidence > 1)
  ) {
    throw new Error("Photo OCR returned invalid confidence.");
  }
  return {
    text: row.text,
    ...(typeof confidence === "number" ? { confidence } : {}),
    engine: "automation",
  };
}

/** Build capture OCR over the gateway's ordinary awaited automation fire. */
export function makeCaptureOcrRecognizer(
  invoke: CaptureAutomationInvoker
): (input: Buffer, mediaType: string) => Promise<OcrExtraction> {
  return async (input: Buffer, mediaType: string): Promise<OcrExtraction> => {
    const result = await invoke(SYSTEM_CAPTURE_OCR_REF, {
      capture: { bytes: input.toString("base64"), mediaType },
    });
    const outcome = result.outcome;
    if (!outcome?.ok) {
      throw new Error(outcome?.error ?? "Photo OCR is unavailable.");
    }
    return extractionFrom(outcome.output);
  };
}
