import { describe, expect, it } from "vitest";

import { parseTesseractTsv } from "./tesseract-ocr.js";

describe("Tesseract-compatible OCR backstop", () => {
  it("parses words, line boundaries, and confidence from bounded TSV", () => {
    const header =
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
    const result = parseTesseractTsv(
      [
        header,
        "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t80.0\tCoffee",
        "5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t100.0\t10.00",
        "5\t1\t1\t1\t2\t1\t0\t0\t10\t10\t90.0\tTax",
      ].join("\n")
    );
    expect(result).toStrictEqual({
      confidence: 0.9,
      engine: "tesseract",
      text: "Coffee 10.00\nTax",
    });
  });

  it("ignores structural rows and rejected words", () => {
    expect(
      parseTesseractTsv(
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t1\t1\t-1\t"
      )
    ).toMatchObject({ confidence: 0, text: "" });
  });
});
