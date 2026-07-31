// Client↔gateway seam laws for quick capture — the module had no test file
// (#656 Layer 1B). Two laws carry the design: capture bytes stream as the
// request body under the file's own media type (no multipart re-encode, so a
// large photo is never buffered into a form), and an ABSENT assist engine
// (HTTP 503) degrades to `undefined` rather than failing the capture — the
// reviewed bytes still stage. Shared harness in gateway-client-seam-fixtures.ts.

import { describe, expect, it } from "vitest";

import {
  capture,
  installSeamContractHarness,
  json,
  respond,
  sent,
  sentJson,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

function receipt(name = "receipt.png", type = "image/png"): File {
  return new File(["PNGBYTES"], name, { type });
}

describe("capture assist seam", () => {
  it("law: OCR posts the file as the raw body under its own media type", async () => {
    const file = receipt();

    await expect(capture.recognizeCaptureImage(file)).resolves.toStrictEqual({
      text: "hi",
      confidence: 0.9,
      engine: "tesseract",
    });
    const request = sent("POST /centraid/_gateway/capture/ocr");
    expect(request.body).toBe(file);
    expect(request.headers.get("content-type")).toBe("image/png");
  });

  it("law: a typeless file still declares a body type the gateway can route", async () => {
    await capture.recognizeCaptureImage(receipt("scan", ""));

    expect(
      sent("POST /centraid/_gateway/capture/ocr").headers.get("content-type")
    ).toBe("application/octet-stream");
  });

  it("law: an absent OCR engine degrades to undefined, never to a thrown capture", async () => {
    respond(
      "POST /centraid/_gateway/capture/ocr",
      () => new Response("", { status: 503 })
    );

    await expect(
      capture.recognizeCaptureImage(receipt())
    ).resolves.toBeUndefined();
  });

  it("law: a real OCR failure is still a failure", async () => {
    respond(
      "POST /centraid/_gateway/capture/ocr",
      () => new Response("boom", { status: 500 })
    );

    await expect(
      capture.recognizeCaptureImage(receipt())
    ).rejects.toMatchObject({
      code: "gateway_error",
    });
  });

  it("law: classification sends the text as JSON and returns the preview candidate", async () => {
    await expect(
      capture.classifyAmbiguousCapture("coffee 4.20")
    ).resolves.toStrictEqual({ kind: "task", title: "Buy milk" });
    expect(sentJson("POST /centraid/_gateway/capture/classify")).toStrictEqual({
      text: "coffee 4.20",
    });
  });

  it("law: an absent classifier degrades to undefined the same way OCR does", async () => {
    respond(
      "POST /centraid/_gateway/capture/classify",
      () => new Response("", { status: 503 })
    );

    await expect(
      capture.classifyAmbiguousCapture("coffee 4.20")
    ).resolves.toBeUndefined();
  });

  it("law: a classifier that answers with no preview reports no candidate", async () => {
    respond("POST /centraid/_gateway/capture/classify", () => json({}));

    await expect(
      capture.classifyAmbiguousCapture("???")
    ).resolves.toBeUndefined();
  });
});

describe("capture staging seam", () => {
  it("law: staged bytes name themselves in the query and stream as the body", async () => {
    const file = receipt();

    await expect(capture.stageCaptureFile(file)).resolves.toBe("a".repeat(64));
    const request = sent("POST /centraid/_vault/blobs");
    expect(Object.fromEntries(request.query)).toStrictEqual({
      filename: "receipt.png",
      media_type: "image/png",
    });
    expect(request.body).toBe(file);
  });

  it("law: a nameless, typeless file stages with no invented metadata", async () => {
    await capture.stageCaptureFile(new File([""], "", { type: "" }));

    expect([...sent("POST /centraid/_vault/blobs").query.keys()]).toStrictEqual(
      []
    );
  });

  it("law: staging without a returned digest is a refusal, not a silent success", async () => {
    respond("POST /centraid/_vault/blobs", () => json({}));

    await expect(capture.stageCaptureFile(receipt())).rejects.toThrow(
      /did not accept the file/u
    );
  });
});

describe("capture blueprint bridge seam", () => {
  it("law: capture reads and writes route through the owning app's own namespace", async () => {
    await capture.runBlueprintCaptureQuery("tally", "recent");
    await capture.runBlueprintCaptureAction(
      "tally",
      "record",
      { amountMinor: 420 },
      "00000000-0000-4000-8000-000000000001"
    );

    expect(wireLog()).toStrictEqual([
      "POST /centraid/tally/queries/recent",
      "POST /centraid/tally/actions/record",
    ]);
    expect(sentJson("POST /centraid/tally/queries/recent")).toStrictEqual({
      input: {},
    });
    expect(sentJson("POST /centraid/tally/actions/record")).toStrictEqual({
      input: { amountMinor: 420 },
      intentId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("law: a write with no caller-supplied intent id still carries a fresh one", async () => {
    await capture.runBlueprintCaptureAction("tally", "record", {});

    expect(sentJson("POST /centraid/tally/actions/record")["intentId"]).toMatch(
      /^[0-9a-f-]{36}$/u
    );
  });

  it("law: app and query ids are percent-encoded into the route", async () => {
    respond("POST /centraid/ta%2Flly/queries/re%20cent", () => json({}));
    await capture.runBlueprintCaptureQuery("ta/lly", "re cent");

    expect(wireLog()).toStrictEqual([
      "POST /centraid/ta%2Flly/queries/re%20cent",
    ]);
  });
});
