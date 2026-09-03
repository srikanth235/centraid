import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { MODELS_DIR } from "../config.js";
import { ctcGreedyDecode } from "../ctc.js";
import {
  computeBoundedMultipleResize,
  roundAndClampBox,
  roundBox,
  scaleBoxToOriginal,
} from "../image-geometry.js";
import { dbPostprocess } from "../ocr-postprocess.js";
import { getOrCreateSession, loadOnnxRuntime } from "../onnx.js";
import {
  cropImage,
  decodeImage,
  decodeImageResized,
  normalizeImageNet,
  resizeDecodedImage,
} from "../preprocess.js";
import type {
  ItemResult,
  ModelId,
  OcrItem,
  OcrRegion,
  OcrResult,
} from "../types.js";

export const OCR_MODEL_ID: ModelId = "pp-ocrv4@1";

const OCR_DIR = path.join(MODELS_DIR, "ocr");
const DET_MODEL_PATH = path.join(OCR_DIR, "det.onnx");
const REC_MODEL_PATH = path.join(OCR_DIR, "rec.onnx");
const DICT_PATH = path.join(OCR_DIR, "dict.txt");

const DET_MAX_SIDE = 960;
const DET_STRIDE_MULTIPLE = 32;
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 320;

export function ocrWeightsPresent(modelsDir: string = MODELS_DIR): boolean {
  const ocrDir = path.join(modelsDir, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every((filename) =>
    existsSync(path.join(ocrDir, filename))
  );
}

export function buildRecognitionDictionary(chars: readonly string[]): string[] {
  return ["", ...chars, " "];
}

export function parseDictFile(contents: string): string[] {
  const lines = contents.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

let cachedDictionary: string[] | undefined;

async function loadDictionary(): Promise<string[]> {
  if (cachedDictionary) {
    return cachedDictionary;
  }
  const contents = await readFile(DICT_PATH, "utf8");
  cachedDictionary = buildRecognitionDictionary(parseDictFile(contents));
  return cachedDictionary;
}

async function detectBoxes(bytes: Uint8Array): Promise<{
  boxes: Array<{
    box: readonly [number, number, number, number];
    score: number;
  }>;
  native: { width: number; height: number };
}> {
  const native = await decodeImage(bytes);
  const target = computeBoundedMultipleResize(
    native.width,
    native.height,
    DET_MAX_SIDE,
    DET_STRIDE_MULTIPLE
  );
  const resized = await decodeImageResized(bytes, target.width, target.height);
  const chw = normalizeImageNet(resized);

  const ort = await loadOnnxRuntime();
  const session = await getOrCreateSession(DET_MODEL_PATH);
  const inputName = session.inputNames[0] ?? "x";
  const fetches = await session.run({
    [inputName]: new ort.Tensor("float32", chw, [
      1,
      3,
      target.height,
      target.width,
    ]),
  });
  const outputName = session.outputNames[0];
  const probMap = outputName ? fetches[outputName]?.data : undefined;
  if (!probMap || !(probMap instanceof Float32Array)) {
    throw new Error("ocr: detector did not return a float32 probability map");
  }

  const detected = dbPostprocess(probMap, target.width, target.height);
  const boxes = detected.map(({ box, score }) => ({
    box: roundBox(scaleBoxToOriginal(box, target, native)),
    score,
  }));
  return { boxes, native };
}

async function recognizeCrop(cropBytes: {
  data: Uint8Array;
  width: number;
  height: number;
}): Promise<{ text: string; confidence: number }> {
  const scale = REC_HEIGHT / cropBytes.height;
  const targetWidth = Math.min(
    REC_MAX_WIDTH,
    Math.max(REC_HEIGHT, Math.round(cropBytes.width * scale))
  );
  const resized = await resizeDecodedImage(cropBytes, targetWidth, REC_HEIGHT);
  const chw = normalizeImageNet(resized);

  const ort = await loadOnnxRuntime();
  const session = await getOrCreateSession(REC_MODEL_PATH);
  const inputName = session.inputNames[0] ?? "x";
  const fetches = await session.run({
    [inputName]: new ort.Tensor("float32", chw, [
      1,
      3,
      REC_HEIGHT,
      targetWidth,
    ]),
  });
  const outputName = session.outputNames[0];
  const output = outputName ? fetches[outputName] : undefined;
  if (!output || !(output.data instanceof Float32Array)) {
    throw new Error("ocr: recognizer did not return a float32 tensor");
  }

  const dictionary = await loadDictionary();
  const numClasses = dictionary.length;
  const timesteps = output.data.length / numClasses;
  const rows: number[][] = [];
  for (let t = 0; t < timesteps; t++) {
    const row = Array.from(
      output.data.subarray(t * numClasses, (t + 1) * numClasses)
    );
    rows.push(row);
  }

  return ctcGreedyDecode(rows, dictionary);
}

export async function ocr(item: OcrItem): Promise<ItemResult<OcrResult>> {
  try {
    const bytes = Buffer.from(item.bytes, "base64");
    const { boxes, native } = await detectBoxes(bytes);
    const decoded = await decodeImage(bytes);
    const declaredDims =
      item.originalWidth && item.originalHeight
        ? { width: item.originalWidth, height: item.originalHeight }
        : { width: native.width, height: native.height };

    const perBox = await Promise.all(
      boxes.map(async (detection): Promise<OcrRegion | undefined> => {
        const [x, y, w, h] = detection.box;
        const crop = cropImage(decoded, { x, y, width: w, height: h });
        if (crop.width <= 0 || crop.height <= 0) {
          return undefined;
        }
        const recognized = await recognizeCrop(crop);
        if (!recognized.text) {
          return undefined;
        }

        const finalBox = roundAndClampBox(
          scaleBoxToOriginal(
            { x, y, width: w, height: h },
            native,
            declaredDims
          ),
          declaredDims.width,
          declaredDims.height
        );
        if (finalBox[2] <= 0 || finalBox[3] <= 0) {
          return undefined;
        }

        return {
          text: recognized.text,
          confidence: recognized.confidence,
          box: finalBox,
        };
      })
    );

    const regions: OcrRegion[] = perBox.filter(
      (region): region is OcrRegion => region !== undefined
    );
    return { id: item.id, regions };
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
