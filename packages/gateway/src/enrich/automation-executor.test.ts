import { afterEach, describe, expect, it } from "vitest";

import { makeAutomationEnrichmentExecutor } from "./automation-executor.js";
import { startFakeEnrichService } from "./fake-enrich-service.test-fixtures.js";
import type { FakeEnrichService } from "./fake-enrich-service.test-fixtures.js";

const services: FakeEnrichService[] = [];

const dispatch = {
  abortSignal: new AbortController().signal,
  automationId: "photo-ocr/photo-ocr",
  runId: "run-1",
};

describe("automation enrichment executor", () => {
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  it("accepts inline image bytes for awaited capture OCR", async () => {
    const service = await startFakeEnrichService({
      capabilities: {
        ocr: {
          result: () => ({
            regions: [{ text: "Total 42", box: [0, 0, 10, 4] }],
          }),
        },
      },
    });
    services.push(service);
    const execute = makeAutomationEnrichmentExecutor(service.config);
    const bytes = Buffer.from("receipt").toString("base64");

    const response = await execute(
      {
        url: "centraid://enrichment/ocr",
        method: "POST",
        body: JSON.stringify({
          items: [{ id: "capture", bytes, mediaType: "image/jpeg" }],
        }),
        attachments: [],
      },
      dispatch
    );

    expect(JSON.parse(response.text)).toMatchObject({
      status: "ok",
      results: [{ id: "capture", regions: [{ text: "Total 42" }] }],
    });
    expect(service.calls).toStrictEqual([
      {
        capability: "ocr",
        items: [{ id: "capture", bytes, mediaType: "image/jpeg" }],
      },
    ]);
  });

  it("rejects inline binary items without an explicit media type", async () => {
    const execute = makeAutomationEnrichmentExecutor(null);
    await expect(
      execute(
        {
          url: "centraid://enrichment/ocr",
          method: "POST",
          body: JSON.stringify({ items: [{ bytes: "cmVjZWlwdA==" }] }),
          attachments: [],
        },
        dispatch
      )
    ).rejects.toThrow("has no binary content");
  });

  it("keeps capability probes honest when no service is configured", async () => {
    const execute = makeAutomationEnrichmentExecutor(null);
    const response = await execute(
      {
        url: "centraid://enrichment/ocr",
        method: "GET",
        attachments: [],
      },
      dispatch
    );
    expect(JSON.parse(response.text)).toMatchObject({ status: "unavailable" });
  });
});
