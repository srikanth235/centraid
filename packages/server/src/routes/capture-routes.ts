import type { IncomingMessage, ServerResponse } from "node:http";

import type { CapturePreview } from "@centraid/server/engine";

import type { OcrExtraction } from "../capture/capture-ocr.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import { readBody, readJson, sendJson } from "./route-helpers.js";

export const CAPTURE_CLASSIFY_PATH = "/centraid/_gateway/capture/classify";
export const CAPTURE_OCR_PATH = "/centraid/_gateway/capture/ocr";
const MAX_OCR_BYTES = 25 * 1024 * 1024;

export interface CaptureRouteOptions {
  classify: (text: string) => Promise<CapturePreview | undefined>;
  recognizeOcr?: (input: Buffer, mediaType: string) => Promise<OcrExtraction>;
}

/** Harness fallback for ambiguous quick-capture text; deterministic cases stay local. */
export function makeCaptureRouteHandler(
  options: CaptureRouteOptions
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (
      url.pathname !== CAPTURE_CLASSIFY_PATH &&
      url.pathname !== CAPTURE_OCR_PATH
    )
      return false;
    if ((req.method ?? "GET") !== "POST")
      return sendJson(res, 405, { error: "method_not_allowed" });
    if (url.pathname === CAPTURE_OCR_PATH) {
      if (!options.recognizeOcr)
        return sendJson(res, 503, { error: "ocr_unavailable" });
      const mediaType = String(req.headers["content-type"] ?? "");
      if (!mediaType.startsWith("image/") && mediaType !== "application/pdf")
        return sendJson(res, 415, { error: "visual_content_required" });
      try {
        const result = await options.recognizeOcr(
          await readBody(req, MAX_OCR_BYTES),
          mediaType
        );
        return sendJson(res, 200, { extraction: result });
      } catch (error) {
        if (error instanceof RangeError)
          return sendJson(res, 413, { error: "content_too_large" });
        return sendJson(res, 503, { error: "ocr_unavailable" });
      }
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: "invalid_body" });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 4_000)
      return sendJson(res, 400, { error: "invalid_capture_text" });
    try {
      const preview = await options.classify(text);
      return preview
        ? sendJson(res, 200, { preview })
        : sendJson(res, 503, { error: "classifier_unavailable" });
    } catch {
      return sendJson(res, 503, { error: "classifier_unavailable" });
    }
  };
}
