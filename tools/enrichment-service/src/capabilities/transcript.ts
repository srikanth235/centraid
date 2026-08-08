import type {
  ItemResult,
  ModelId,
  TranscriptItem,
  TranscriptResult,
} from "../types.js";

// transcript is a PROXY, not local ASR: it forwards to a whisper-compatible
// endpoint (OpenAI's `/v1/audio/transcriptions` multipart form contract)
// configured via ENRICH_SERVICE_TRANSCRIPT_URL. No model weights, no ONNX,
// no runtime/ dependency for this capability at all.
export const TRANSCRIPT_MODEL_ID: ModelId = "whisper-proxy@1";

const PROBE_TIMEOUT_MS = 2000;

export function guessExtension(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.split(";")[0]?.trim();
  return subtype && /^[a-z0-9]+$/iu.test(subtype) ? subtype : "bin";
}

/**
 * Probes the configured transcript endpoint so /capabilities only advertises
 * transcript when the endpoint is actually reachable (issue #724 W8:
 * "advertise transcript only when that env var is set AND the endpoint
 * answers a probe"). A bare `GET` on the base URL is used as a liveness
 * check — most OpenAI-compatible servers respond to an unauthenticated GET
 * with SOME status code (even 404/405) rather than a connection failure,
 * which is all this probe needs to distinguish "endpoint up" from "endpoint
 * unreachable".
 */
export async function probeTranscriptEndpoint(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      return response.status < 500;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

export async function transcript(
  item: TranscriptItem,
  transcriptUrl: string
): Promise<ItemResult<TranscriptResult>> {
  try {
    const bytes = Buffer.from(item.bytes, "base64");
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(bytes)], { type: item.mediaType }),
      `audio.${guessExtension(item.mediaType)}`
    );
    form.set("model", "whisper-1");

    const response = await fetch(transcriptUrl, { method: "POST", body: form });
    if (!response.ok) {
      return {
        id: item.id,
        error: `transcript endpoint returned ${response.status}`,
      };
    }
    const body = (await response.json()) as { text?: string };
    if (typeof body.text !== "string") {
      return {
        id: item.id,
        error: "transcript endpoint response was missing a text field",
      };
    }
    return { id: item.id, text: body.text };
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
