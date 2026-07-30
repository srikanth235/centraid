import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

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
        servers
          .splice(0)
          .map(
            (server) =>
              new Promise<void>((resolve) => server.close(() => resolve()))
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

  it("accepts only bounded image bytes for the private OCR backstop", async () => {
    const recognizeOcr = vi.fn<
      (input: Buffer) => Promise<{
        confidence: number;
        engine: "tesseract";
        text: string;
      }>
    >(async (input) => ({
      confidence: 0.9,
      engine: "tesseract",
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
    expect(recognizeOcr).toHaveBeenCalledOnce();
    await expect(
      requestRaw(
        handler,
        CAPTURE_OCR_PATH,
        Buffer.from("not image"),
        "text/plain"
      )
    ).resolves.toMatchObject({ status: 415 });
  });
});

async function request(
  handler: ReturnType<typeof makeCaptureRouteHandler>,
  method: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const server = createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  return { status: response.status, body: await response.json() };
}
