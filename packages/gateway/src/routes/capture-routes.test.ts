import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeCaptureOcrRecognizer } from "../capture/capture-ocr.js";
import type { CaptureAutomationInvoker } from "../capture/capture-ocr.js";
import { SYSTEM_CAPTURE_OCR_REF } from "../enrich/system-recognition.js";
import {
  CAPTURE_CLASSIFY_PATH,
  CAPTURE_OCR_PATH,
  makeCaptureRouteHandler,
} from "./capture-routes.js";

const servers: import("node:http").Server[] = [];

describe("capture classify route", () => {
  afterEach(
    async () =>
      void (await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            })
        )
      ))
  );

  it("validates input and returns a bounded preview", async () => {
    const classify = vi.fn<(text: string) => Promise<unknown>>(async () => ({
      kind: "task",
      title: "Call Priya",
    }));
    const response = await request(
      makeCaptureRouteHandler({
        classify: classify as Parameters<
          typeof makeCaptureRouteHandler
        >[0]["classify"],
      }),
      "POST",
      { text: "Maybe call Priya" }
    );
    expect(response).toMatchObject({
      status: 200,
      body: { preview: { kind: "task" } },
    });
    expect(classify).toHaveBeenCalledWith("Maybe call Priya");
  });

  it("fails closed when no local classifier is available", async () => {
    const response = await request(
      makeCaptureRouteHandler({ classify: async () => undefined }),
      "POST",
      { text: "Maybe call Priya" }
    );
    expect(response.status).toBe(503);
  });

  it("accepts only bounded image/PDF bytes for the OCR automation", async () => {
    const recognizeOcr = vi.fn<
      (
        input: Buffer,
        mediaType: string
      ) => Promise<{
        confidence: number;
        engine: "automation";
        text: string;
      }>
    >(async (input) => ({
      confidence: 0.9,
      engine: "automation",
      text: input.toString("utf8"),
    }));
    const handler = makeCaptureRouteHandler({
      classify: async () => undefined,
      recognizeOcr,
    });
    const response = await requestRaw(
      handler,
      CAPTURE_OCR_PATH,
      Buffer.from("receipt"),
      "image/jpeg"
    );
    expect(response).toMatchObject({
      status: 200,
      body: { extraction: { text: "receipt" } },
    });
    expect(recognizeOcr).toHaveBeenCalledWith(
      Buffer.from("receipt"),
      "image/jpeg"
    );
    const pdf = Buffer.from("%PDF-1.7\nfixture\n%%EOF");
    await expect(
      requestRaw(handler, CAPTURE_OCR_PATH, pdf, "application/pdf")
    ).resolves.toMatchObject({
      status: 200,
      body: { extraction: { text: pdf.toString("utf8") } },
    });
    expect(recognizeOcr).toHaveBeenLastCalledWith(pdf, "application/pdf");
    await expect(
      requestRaw(
        handler,
        CAPTURE_OCR_PATH,
        Buffer.from("not image"),
        "text/plain"
      )
    ).resolves.toMatchObject({ status: 415 });
  });

  describe("recognizeOcr enters the awaited Photo OCR automation", () => {
    it("passes inline bytes to the stable recipe and returns its result", async () => {
      const invoke = vi.fn<CaptureAutomationInvoker>(async () => ({
        outcome: {
          ok: true,
          output: {
            text: "hello\nworld",
            confidence: 0.7,
            engine: "automation",
          },
        },
      }));
      const handler = makeCaptureRouteHandler({
        classify: async () => undefined,
        recognizeOcr: makeCaptureOcrRecognizer(invoke),
      });
      const response = await requestRaw(
        handler,
        CAPTURE_OCR_PATH,
        Buffer.from("receipt"),
        "image/jpeg"
      );
      expect(response).toMatchObject({
        status: 200,
        body: {
          extraction: {
            text: "hello\nworld",
            confidence: 0.7,
            engine: "automation",
          },
        },
      });
      expect(invoke).toHaveBeenCalledWith(SYSTEM_CAPTURE_OCR_REF, {
        capture: {
          bytes: Buffer.from("receipt").toString("base64"),
          mediaType: "image/jpeg",
        },
      });
    });

    it("answers 503 when the recipe is skipped by policy", async () => {
      const handler = makeCaptureRouteHandler({
        classify: async () => undefined,
        recognizeOcr: makeCaptureOcrRecognizer(async () => ({
          outcome: {
            ok: false,
            skipped: true,
            error: "photos enrichment is off",
          },
        })),
      });
      const response = await requestRaw(
        handler,
        CAPTURE_OCR_PATH,
        Buffer.from("receipt"),
        "image/jpeg"
      );
      expect(response.status).toBe(503);
      expect(response.body).toStrictEqual({ error: "ocr_unavailable" });
    });

    it("answers 503 when the recipe records service unavailability as failure", async () => {
      const handler = makeCaptureRouteHandler({
        classify: async () => undefined,
        recognizeOcr: makeCaptureOcrRecognizer(async () => ({
          outcome: { ok: false, error: "capture OCR unavailable" },
        })),
      });
      const response = await requestRaw(
        handler,
        CAPTURE_OCR_PATH,
        Buffer.from("receipt"),
        "image/jpeg"
      );
      expect(response.status).toBe(503);
    });
  });
});

async function request(
  handler: ReturnType<typeof makeCaptureRouteHandler>,
  method: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const server = createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const response = await fetch(
    `http://127.0.0.1:${address.port}${CAPTURE_CLASSIFY_PATH}`,
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return { status: response.status, body: await response.json() };
}

async function requestRaw(
  handler: ReturnType<typeof makeCaptureRouteHandler>,
  path: string,
  body: Buffer,
  contentType: string
): Promise<{ status: number; body: unknown }> {
  const server = createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  return { status: response.status, body: await response.json() };
}
