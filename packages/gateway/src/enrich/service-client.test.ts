// The enrichment service client (issue #724 W1) — behaviour against a REAL
// loopback server, because every claim this module makes is a claim about
// foreign input arriving over a socket: what it refuses to be configured with,
// what it survives, and what it never turns into an exception.

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import {
  fakeVectorFor,
  startFakeEnrichService,
} from "./fake-enrich-service.test-fixtures.js";
import type { FakeEnrichService } from "./fake-enrich-service.test-fixtures.js";
import {
  ENRICH_UNCONFIGURED_REASON,
  MAX_ENRICH_BATCH,
  enrichBatch,
  getEnrichCapabilities,
  isEnrichFailure,
  probeEnrichService,
  readEnrichServiceConfig,
} from "./service-client.js";
import type { EnrichImageItem } from "./service-client.js";

const services: FakeEnrichService[] = [];

async function start(
  ...args: Parameters<typeof startFakeEnrichService>
): Promise<FakeEnrichService> {
  const service = await startFakeEnrichService(...args);
  services.push(service);
  return service;
}

/** A tiny image item; the fake's vector is derived from these exact bytes. */
function imageItem(id: string, bytes: number[]): EnrichImageItem {
  return {
    id,
    mediaType: "image/jpeg",
    bytes: Buffer.from(bytes).toString("base64"),
  };
}

describe("enrichment service config", () => {
  test("only an explicitly configured loopback URL is read", () => {
    expect(
      readEnrichServiceConfig({ CENTRAID_ENRICH_URL: "http://127.0.0.1:9000" })
        ?.endpoint.href
    ).toBe("http://127.0.0.1:9000/");
    expect(
      readEnrichServiceConfig({ CENTRAID_ENRICH_URL: "https://localhost:9000" })
        ?.endpoint.hostname
    ).toBe("localhost");
    expect(
      readEnrichServiceConfig({ CENTRAID_ENRICH_URL: "http://[::1]:9000" })
    ).not.toBeNull();
    expect(readEnrichServiceConfig({})).toBeNull();
  });

  test("a URL that could send an owner's photographs off the host is refused", () => {
    for (const url of [
      "http://models.example.com:9000",
      "http://10.0.0.4:9000",
      "http://127.0.0.1.evil.example:9000",
      "ftp://127.0.0.1:9000",
      "not a url",
      "http://user:secret@127.0.0.1:9000",
    ]) {
      expect(readEnrichServiceConfig({ CENTRAID_ENRICH_URL: url })).toBeNull();
    }
  });

  test("the token is configuration, and it travels in a header", async () => {
    const config = readEnrichServiceConfig({
      CENTRAID_ENRICH_URL: "http://127.0.0.1:9000",
      CENTRAID_ENRICH_TOKEN: "  hunter2  ",
    });
    expect(config?.token).toBe("hunter2");
    expect(config?.endpoint.href).not.toContain("hunter2");

    const service = await start({ token: "hunter2" });
    const authorized = await probeEnrichService(service.config, "embed-text");
    expect(authorized.status).toBe("ok");
    const anonymous = await probeEnrichService(
      { endpoint: service.config.endpoint },
      "embed-text"
    );
    expect(anonymous.status).toBe("unavailable");
  });
});

describe("enrichment service client", () => {
  afterEach(async () => {
    await forEachSequentially(services.splice(0), (service) => service.close());
  });

  test("an unconfigured gateway is unavailable, never an error", async () => {
    const probe = await probeEnrichService(null, "embed-image");
    expect(probe).toStrictEqual({
      status: "unavailable",
      reason: ENRICH_UNCONFIGURED_REASON,
    });
    const batch = await enrichBatch(null, "embed-image", [
      imageItem("a", [1, 2, 3]),
    ]);
    expect(batch).toStrictEqual({
      status: "unavailable",
      reason: ENRICH_UNCONFIGURED_REASON,
    });
  });

  test("capabilities are read with their model ids", async () => {
    const service = await start({
      capabilities: { "embed-image": { model: "clip@3" }, ocr: {} },
    });
    const outcome = await getEnrichCapabilities(service.config);
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.capabilities["embed-image"]).toStrictEqual({
      model: "clip@3",
    });
    expect(outcome.capabilities.ocr).toStrictEqual({ model: "fake-ocr@1" });
    expect(outcome.capabilities.faces).toBeUndefined();
  });

  test("a capability whose model id could never be backfilled is not offered", async () => {
    const service = await start({
      capabilities: { "embed-image": { model: "CLIP ViT-B/32 (final)" } },
    });
    const probe = await probeEnrichService(service.config, "embed-image");
    expect(probe.status).toBe("unavailable");
  });

  test("a capability the service does not advertise is unavailable, not a throw", async () => {
    const service = await start({ capabilities: { "embed-text": {} } });
    const probe = await probeEnrichService(service.config, "faces");
    expect(probe).toStrictEqual({
      status: "unavailable",
      reason: "the enrichment service does not offer faces",
    });
    const batch = await enrichBatch(service.config, "faces", [
      imageItem("a", [1, 2, 3]),
    ]);
    expect(batch.status).toBe("unavailable");
  });

  test("every way a probe can fail is the same fact: nothing can be derived", async () => {
    await forEachSequentially(
      ["server-error", "truncated-json"] as const,
      async (probe) => {
        const service = await start({ probe });
        const outcome = await getEnrichCapabilities(service.config);
        expect(outcome.status).toBe("unavailable");
      }
    );
    const hung = await start({ probe: "hang" });
    const outcome = await getEnrichCapabilities(hung.config, {
      timeoutMs: 150,
    });
    expect(outcome.status).toBe("unavailable");

    const unreachable = await start();
    await unreachable.close();
    services.pop();
    expect((await getEnrichCapabilities(unreachable.config)).status).toBe(
      "unavailable"
    );
  });

  test("a batch comes back in request order with the model that ran it", async () => {
    const service = await start();
    const items = [
      imageItem("first", [10, 20, 30, 40]),
      imageItem("second", [200, 100, 50, 25]),
    ];
    const outcome = await enrichBatch(service.config, "embed-image", items);
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.model).toBe("fake-clip@1");
    expect(outcome.results.map((result) => result.id)).toStrictEqual([
      "first",
      "second",
    ]);
    expect(outcome.results[0]).toStrictEqual({
      id: "first",
      vector: fakeVectorFor(Buffer.from([10, 20, 30, 40])),
    });
    // The bytes really did cross a socket as base64.
    expect(service.calls[0]!.items[1]!["bytes"]).toBe(
      Buffer.from([200, 100, 50, 25]).toString("base64")
    );
  });

  test("results pair with items by position, not by the id the service echoed", async () => {
    const service = await start({
      capabilities: {
        "embed-image": { result: () => ({ id: "someone-else", vector: [1] }) },
      },
    });
    const outcome = await enrichBatch(service.config, "embed-image", [
      imageItem("mine", [1]),
    ]);
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.results[0]!.id).toBe("mine");
  });

  test("one item the model refuses costs one result, never the batch", async () => {
    const service = await start({
      capabilities: {
        "embed-image": {
          result: (_item, index) =>
            index === 0
              ? { error: "could not decode" }
              : { vector: [0.1, 0.2, 0.3] },
        },
      },
    });
    const outcome = await enrichBatch(service.config, "embed-image", [
      imageItem("bad", [1]),
      imageItem("good", [2]),
    ]);
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.results[0]).toStrictEqual({
      id: "bad",
      error: "could not decode",
    });
    expect(isEnrichFailure(outcome.results[1]!)).toBe(false);
  });

  test("an unusable vector is that item's failure, not a row of nonsense", async () => {
    const service = await start({
      capabilities: {
        "embed-image": {
          result: (_item, index) =>
            [
              { vector: Array.from({ length: 4097 }, () => 0.5) },
              { vector: [1, Number.NaN, 3] },
              { vector: "not a vector" },
              { vector: [0.5, 0.5] },
            ][index],
        },
      },
    });
    const outcome = await enrichBatch(
      service.config,
      "embed-image",
      ["wide", "nan", "prose", "fine"].map((id, index) =>
        imageItem(id, [index])
      )
    );
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(
      outcome.results.map((result) => isEnrichFailure(result))
    ).toStrictEqual([true, true, true, false]);
    expect((outcome.results[0] as { error: string }).error).toContain("4097");
  });

  test("a service that misbehaves at the envelope is unavailable, never a throw", async () => {
    await forEachSequentially(
      [
        "server-error",
        "truncated-json",
        "oversize",
        "wrong-count",
        "bad-model",
      ] as const,
      async (misbehave) => {
        const service = await start({
          capabilities: { "embed-image": { misbehave } },
        });
        const outcome = await enrichBatch(service.config, "embed-image", [
          imageItem("a", [1]),
          imageItem("b", [2]),
        ]);
        expect(outcome.status).toBe("unavailable");
      }
    );
  });

  test("a hung service costs one timeout, not a wedged sweep", async () => {
    const service = await start({
      capabilities: { "embed-image": { misbehave: "hang" } },
    });
    const started = Date.now();
    const outcome = await enrichBatch(
      service.config,
      "embed-image",
      [imageItem("a", [1])],
      { timeoutMs: 150 }
    );
    expect(outcome.status).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a batch this client could not honour is a caller bug, and says so", async () => {
    const service = await start();
    await expect(
      enrichBatch(service.config, "embed-image", [])
    ).rejects.toThrow(/at least one item/u);
    await expect(
      enrichBatch(
        service.config,
        "embed-image",
        Array.from({ length: MAX_ENRICH_BATCH + 1 }, (_, i) =>
          imageItem(`a${i}`, [i])
        )
      )
    ).rejects.toThrow(/at most 16 items/u);
  });

  test("text embedding rides the same contract", async () => {
    const service = await start();
    const outcome = await enrichBatch(service.config, "embed-text", [
      { id: "query", text: "a dog on a beach" },
    ]);
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.results[0]).toStrictEqual({
      id: "query",
      vector: fakeVectorFor("a dog on a beach"),
    });
  });

  test("regions arrive in the original photograph's pixels, and absurd boxes do not", async () => {
    const service = await start({
      capabilities: {
        ocr: {
          result: (item) => ({
            regions: [
              {
                text: "RECEIPT",
                confidence: 0.9,
                box:
                  item["id"] === "sane"
                    ? [10, 20, 100, 40]
                    : [10, 20, 4000, 40],
              },
            ],
          }),
        },
      },
    });
    const outcome = await enrichBatch(service.config, "ocr", [
      {
        id: "sane",
        mediaType: "image/jpeg",
        bytes: "AAA=",
        originalWidth: 1200,
        originalHeight: 800,
      },
      {
        id: "absurd",
        mediaType: "image/jpeg",
        bytes: "AAA=",
        originalWidth: 1200,
        originalHeight: 800,
      },
    ]);
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.results[0]).toStrictEqual({
      id: "sane",
      regions: [{ text: "RECEIPT", confidence: 0.9, box: [10, 20, 100, 40] }],
    });
    expect(isEnrichFailure(outcome.results[1]!)).toBe(true);
  });

  test("a face carries a box, a confidence in 0..1, and an embedding", async () => {
    const service = await start({
      capabilities: {
        faces: {
          result: (item) => ({
            faces: [
              {
                box: [1, 2, 30, 40],
                confidence: item["id"] === "sane" ? 0.75 : 7.5,
                embedding: [0.1, 0.2],
              },
            ],
          }),
        },
      },
    });
    const outcome = await enrichBatch(service.config, "faces", [
      { id: "sane", mediaType: "image/jpeg", bytes: "AAA=" },
      { id: "overconfident", mediaType: "image/jpeg", bytes: "AAA=" },
    ]);
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.results[0]).toStrictEqual({
      id: "sane",
      faces: [{ box: [1, 2, 30, 40], confidence: 0.75, embedding: [0.1, 0.2] }],
    });
    expect(isEnrichFailure(outcome.results[1]!)).toBe(true);
  });

  test("a transcript is text, with confidence only when the service scored it", async () => {
    const service = await start({
      capabilities: {
        transcript: {
          result: (item) =>
            item["id"] === "scored"
              ? { text: "hello there", confidence: 0.5 }
              : { text: "hello there" },
        },
      },
    });
    const outcome = await enrichBatch(service.config, "transcript", [
      { id: "scored", mediaType: "audio/mpeg", bytes: "AAA=" },
      { id: "unscored", mediaType: "audio/mpeg", bytes: "AAA=" },
    ]);
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.results[0]).toStrictEqual({
      id: "scored",
      text: "hello there",
      confidence: 0.5,
    });
    expect(outcome.results[1]).toStrictEqual({
      id: "unscored",
      text: "hello there",
    });
  });
});
