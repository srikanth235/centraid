import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  buildRecognitionDictionary,
  ocrWeightsPresent,
  parseDictFile,
} from "./ocr.js";

const OCR_WEIGHT_FILES = ["det.onnx", "rec.onnx", "dict.txt"];

describe(ocrWeightsPresent, () => {
  it("requires the detector, recognizer, and dictionary files", () => {
    const models = tempDirSync("centraid-ocr-model-");
    expect(ocrWeightsPresent(models)).toBe(false);
    const ocrDir = path.join(models, "ocr");
    mkdirSync(ocrDir, { recursive: true });
    for (const file of OCR_WEIGHT_FILES) {
      writeFileSync(path.join(ocrDir, file), file);
    }
    expect(ocrWeightsPresent(models)).toBe(true);
  });
});

describe(parseDictFile, () => {
  it("splits one character per line", () => {
    expect(parseDictFile("a\nb\nc\n")).toStrictEqual(["a", "b", "c"]);
  });

  it("drops only the final trailing-newline segment, not a genuine blank entry", () => {
    expect(parseDictFile("a\n\nb\n")).toStrictEqual(["a", "", "b"]);
  });

  it("handles a file with no trailing newline", () => {
    expect(parseDictFile("a\nb")).toStrictEqual(["a", "b"]);
  });
});

describe(buildRecognitionDictionary, () => {
  it("prepends the CTC blank and appends a space class", () => {
    expect(buildRecognitionDictionary(["a", "b", "c"])).toStrictEqual([
      "",
      "a",
      "b",
      "c",
      " ",
    ]);
  });
});
