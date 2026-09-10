import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  ensureModelAssets,
  lockCapabilities,
  readModelLock,
} from "./model-assets.js";
import type { ModelLock } from "./model-assets.js";

const WEIGHTS = "pretend these are weights\n";
const AUXILIARY = "pretend this is a dictionary\n";

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A manifest shaped exactly like the real one, small enough to serve. */
const LOCK: ModelLock = {
  schemaVersion: 1,
  files: [
    {
      model: "test-faces@1",
      path: "faces/detector.onnx",
      capabilities: ["faces"],
      bytes: Buffer.byteLength(WEIGHTS),
      sha256: sha256(WEIGHTS),
      license: "MIT",
      url: "https://example.invalid/detector.onnx",
    },
    {
      model: "test-faces@1",
      path: "faces/recognizer.onnx",
      capabilities: ["faces"],
      bytes: Buffer.byteLength(WEIGHTS),
      sha256: sha256(WEIGHTS),
      license: "MIT",
      url: "https://example.invalid/recognizer.onnx",
    },
    {
      model: "test-ocr@1",
      path: "ocr/dict.txt",
      capabilities: ["ocr"],
      bytes: Buffer.byteLength(AUXILIARY),
      sha256: sha256(AUXILIARY),
      license: "Apache-2.0",
      url: "https://example.invalid/dict.txt",
    },
  ],
};

/** Serves `bodies` by URL; anything else 404s. Returns the request log. */
function stubFetch(bodies: Readonly<Record<string, string>>): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    requested.push(url);
    const body = bodies[url];
    return Promise.resolve(
      body === undefined
        ? new Response(null, { status: 404, statusText: "Not Found" })
        : new Response(body, { status: 200 })
    );
  });
  return requested;
}

const EVERYTHING = {
  "https://example.invalid/detector.onnx": WEIGHTS,
  "https://example.invalid/recognizer.onnx": WEIGHTS,
  "https://example.invalid/dict.txt": AUXILIARY,
};

describe(lockCapabilities, () => {
  it("enumerates the shipped manifest's capabilities", async () => {
    expect(lockCapabilities(await readModelLock()).toSorted()).toStrictEqual([
      "embed-image",
      "embed-text",
      "faces",
      "ocr",
      "transcript",
    ]);
  });
});

describe(ensureModelAssets, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a requested capability and touches no other", async () => {
    const requested = stubFetch(EVERYTHING);
    const runtimeDir = tempDirSync("centraid-model-assets-");

    const result = await ensureModelAssets({
      runtimeDir,
      capabilities: ["faces"],
      lock: LOCK,
    });

    expect(result).toStrictEqual({
      ready: ["faces"],
      fetched: ["faces/detector.onnx", "faces/recognizer.onnx"],
      failed: [],
    });
    expect(requested).toStrictEqual([
      "https://example.invalid/detector.onnx",
      "https://example.invalid/recognizer.onnx",
    ]);
    const models = path.join(runtimeDir, "models");
    expect(readFileSync(path.join(models, "faces/detector.onnx"), "utf8")).toBe(
      WEIGHTS
    );
    // The OCR files were never asked for, so not a byte of them exists.
    expect(existsSync(path.join(models, "ocr"))).toBe(false);
  });

  it("is idempotent: a second call verifies and fetches nothing", async () => {
    stubFetch(EVERYTHING);
    const runtimeDir = tempDirSync("centraid-model-assets-");
    await ensureModelAssets({
      runtimeDir,
      capabilities: ["faces", "ocr"],
      lock: LOCK,
    });

    const requested = stubFetch(EVERYTHING);
    const second = await ensureModelAssets({
      runtimeDir,
      capabilities: ["faces", "ocr"],
      lock: LOCK,
    });

    expect(second).toStrictEqual({
      ready: ["faces", "ocr"],
      fetched: [],
      failed: [],
    });
    expect(requested).toStrictEqual([]);
  });

  it("re-fetches a file whose bytes no longer match the pin", async () => {
    stubFetch(EVERYTHING);
    const runtimeDir = tempDirSync("centraid-model-assets-");
    await ensureModelAssets({
      runtimeDir,
      capabilities: ["ocr"],
      lock: LOCK,
    });
    const dictionary = path.join(runtimeDir, "models/ocr/dict.txt");
    writeFileSync(dictionary, "truncated");

    const requested = stubFetch(EVERYTHING);
    const result = await ensureModelAssets({
      runtimeDir,
      capabilities: ["ocr"],
      lock: LOCK,
    });

    expect(result.fetched).toStrictEqual(["ocr/dict.txt"]);
    expect(requested).toHaveLength(1);
    expect(readFileSync(dictionary, "utf8")).toBe(AUXILIARY);
  });

  it("reports an unreachable upstream instead of throwing", async () => {
    stubFetch({});
    const runtimeDir = tempDirSync("centraid-model-assets-");

    const result = await ensureModelAssets({
      runtimeDir,
      capabilities: ["faces", "ocr"],
      lock: { ...LOCK, files: LOCK.files.slice(0, 1) },
    });

    expect(result.ready).toStrictEqual([]);
    expect(result.fetched).toStrictEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.capability).toBe("faces");
    expect(result.failed[0]?.error).toContain("404");
    expect(result.failed[1]).toStrictEqual({
      capability: "ocr",
      error: 'no pinned assets for capability "ocr"',
    });
    expect(
      existsSync(path.join(runtimeDir, "models/faces/detector.onnx"))
    ).toBe(false);
  });

  it("never renames a body that fails its digest into place", async () => {
    stubFetch({
      "https://example.invalid/detector.onnx": "these are the wrong bytes",
      "https://example.invalid/recognizer.onnx": WEIGHTS,
    });
    const runtimeDir = tempDirSync("centraid-model-assets-");

    const result = await ensureModelAssets({
      runtimeDir,
      capabilities: ["faces"],
      lock: LOCK,
    });

    expect(result.ready).toStrictEqual([]);
    expect(result.failed[0]?.error).toContain("sha256 mismatch");
    const detector = path.join(runtimeDir, "models/faces/detector.onnx");
    expect(existsSync(detector)).toBe(false);
    // …and no half-written temp file survives either.
    expect(existsSync(`${detector}.partial`)).toBe(false);
  });

  it("leaves an intact file alone when a sibling in the same capability fails", async () => {
    stubFetch(EVERYTHING);
    const runtimeDir = tempDirSync("centraid-model-assets-");
    const detector = path.join(runtimeDir, "models/faces/detector.onnx");
    mkdirSync(path.dirname(detector), { recursive: true });
    writeFileSync(detector, WEIGHTS);

    const requested = stubFetch({
      "https://example.invalid/recognizer.onnx": "wrong",
    });
    const result = await ensureModelAssets({
      runtimeDir,
      capabilities: ["faces"],
      lock: LOCK,
    });

    expect(result.failed).toHaveLength(1);
    // Only the sibling was requested: the pinned file was verified, not
    // re-downloaded, which is the property that makes boot-time calls cheap.
    expect(requested).toStrictEqual([
      "https://example.invalid/recognizer.onnx",
    ]);
    expect(readFileSync(detector, "utf8")).toBe(WEIGHTS);
  });
});
