import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  EMBED_MODEL_ID,
  embedWeightsPresent,
  embedImage,
} from "./capabilities/embed.js";
import {
  FACES_MODEL_ID,
  faces,
  facesWeightsPresent,
} from "./capabilities/faces.js";
import { OCR_MODEL_ID, ocr, ocrWeightsPresent } from "./capabilities/ocr.js";
import {
  TRANSCRIPT_MODEL_ID,
  transcriptWeightsPresent,
} from "./capabilities/transcript.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SAMPLE = path.join(ROOT, "packages/blueprints/apps/photos/sample");
const FIXTURES = path.join(ROOT, "packages/model-runtime/fixtures");

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
  });

  it("has every model pair bundled automation handlers load directly", () => {
    expect({
      "embed-image": embedWeightsPresent() ? EMBED_MODEL_ID : undefined,
      "embed-text": embedWeightsPresent() ? EMBED_MODEL_ID : undefined,
      ocr: ocrWeightsPresent() ? OCR_MODEL_ID : undefined,
      faces: facesWeightsPresent() ? FACES_MODEL_ID : undefined,
      transcript: transcriptWeightsPresent() ? TRANSCRIPT_MODEL_ID : undefined,
    }).toStrictEqual({
      "embed-image": "clip-vit-b-32@1",
      "embed-text": "clip-vit-b-32@1",
      ocr: "pp-ocrv4@1",
      faces: "yunet-sface@1",
      transcript: "whisper-tiny.en-q8@1",
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
