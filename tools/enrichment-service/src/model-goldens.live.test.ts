import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { embedImage } from "./capabilities/embed.js";
import { faces } from "./capabilities/faces.js";
import { ocr } from "./capabilities/ocr.js";
import { MODELS_DIR } from "./config.js";
import { createServer } from "./server.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SAMPLE = path.join(ROOT, "packages/blueprints/apps/photos/sample");
const FIXTURES = path.join(ROOT, "tools/enrichment-service/fixtures");

async function imageItem(filename: string) {
  return {
    id: filename,
    mediaType: "image/png",
    bytes: (await readFile(path.join(SAMPLE, filename))).toString("base64"),
  };
}

async function fixtureItem(
  filename: string,
  mediaType: string,
  encoded = false
) {
  const contents = await readFile(path.join(FIXTURES, filename));
  return {
    id: filename,
    mediaType,
    bytes: encoded
      ? contents.toString("utf8").trim()
      : contents.toString("base64"),
  };
}

let server: ReturnType<typeof createServer>;
let baseUrl = "";
let goldens: {
  embedding: string;
  ocr: Array<{ text: string; confidence: number; box: number[] }>;
  faces: Array<{ confidence: number; box: number[] }>;
};

function cosine(left: readonly number[], right: readonly number[]): number {
  expect(left).toHaveLength(right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
    leftNorm += (left[index] ?? 0) ** 2;
    rightNorm += (right[index] ?? 0) ** 2;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

describe("[law:enrichment-live] pinned real-model goldens", () => {
  beforeAll(async () => {
    goldens = JSON.parse(
      await readFile(path.join(FIXTURES, "model-goldens.json"), "utf8")
    ) as typeof goldens;
    server = createServer({
      port: 0,
      authToken: undefined,
      transcriptUrl: undefined,
      maxBodyBytes: 64 * 1024 * 1024,
      modelsDir: MODELS_DIR,
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it("advertises the four locally-backed capability/model pairs", async () => {
    const response = await fetch(`${baseUrl}/capabilities`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      capabilities: {
        "embed-image": { model: "clip-vit-b-32@1" },
        "embed-text": { model: "clip-vit-b-32@1" },
        ocr: { model: "pp-ocrv4@1" },
        faces: { model: "yunet-sface@1" },
      },
    });
  });

  it("runs the image embedding, OCR, and face models against committed fixtures", async () => {
    const [embedded, recognized, detected] = await Promise.all([
      embedImage(await imageItem("ana-profile-doorway.png")),
      ocr(await fixtureItem("ocr-golden.svg", "image/svg+xml")),
      faces(await fixtureItem("opencv-lena.jpg.base64", "image/jpeg", true)),
    ]);
    expect(embedded).not.toHaveProperty("error");
    expect(recognized).not.toHaveProperty("error");
    expect(detected).not.toHaveProperty("error");
    if ("error" in embedded || "error" in recognized || "error" in detected) {
      throw new Error(JSON.stringify({ embedded, recognized, detected }));
    }
    const goldenBytes = Buffer.from(goldens.embedding, "base64");
    const goldenEmbedding = Array.from(
      new Float32Array(
        goldenBytes.buffer,
        goldenBytes.byteOffset,
        goldenBytes.byteLength / Float32Array.BYTES_PER_ELEMENT
      )
    );
    expect(cosine(embedded.vector, goldenEmbedding)).toBeGreaterThan(0.999);

    expect(recognized.regions.map((region) => region.text)).toStrictEqual(
      goldens.ocr.map((region) => region.text)
    );
    recognized.regions.forEach((region, index) => {
      const golden = goldens.ocr[index]!;
      expect(region.confidence).toBeGreaterThan(golden.confidence - 0.03);
      region.box.forEach((coordinate, coordinateIndex) => {
        expect(
          Math.abs(coordinate - golden.box[coordinateIndex]!)
        ).toBeLessThanOrEqual(6);
      });
    });

    expect(detected.faces).toHaveLength(goldens.faces.length);
    detected.faces.forEach((face, index) => {
      const golden = goldens.faces[index]!;
      expect(face.confidence).toBeGreaterThan(golden.confidence - 0.03);
      face.box.forEach((coordinate, coordinateIndex) => {
        expect(
          Math.abs(coordinate - golden.box[coordinateIndex]!)
        ).toBeLessThanOrEqual(6);
      });
    });
  });
});
