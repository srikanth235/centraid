import { deflateSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import { extractPdfText } from "./pdf-text.js";

function clearTextPdf(text: string): Buffer {
  const stream = `BT (${text}) Tj ET`;
  const body = [
    "%PDF-1.4",
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj",
    "3 0 obj<< /Type /Page /Parent 2 0 R /Contents 4 0 R /MediaBox [0 0 200 200] >>endobj",
    `4 0 obj<< /Length ${stream.length} >>stream`,
    stream,
    "endstream",
    "endobj",
    "trailer<< /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return Buffer.from(body, "latin1");
}

function flateTextPdf(text: string): Buffer {
  const raw = Buffer.from(`BT (${text}) Tj ET`, "latin1");
  const compressed = deflateSync(raw);
  const dict = `<< /Filter /FlateDecode /Length ${compressed.length} >>`;
  const parts = [
    Buffer.from("%PDF-1.4\n"),
    Buffer.from(`${dict}stream\n`, "latin1"),
    compressed,
    Buffer.from("\nendstream\n", "latin1"),
  ];
  return Buffer.concat(parts);
}

describe("pdf-text", () => {
  test("extractPdfText returns null for non-PDF and short probes", () => {
    expect(extractPdfText(Buffer.from("not a pdf"))).toBeNull();
    expect(extractPdfText(Buffer.from(""))).toBeNull();
    expect(extractPdfText(clearTextPdf("short"))).toBeNull();
  });

  test("extractPdfText pulls clear-text Tj content past the usefulness floor", () => {
    const text = "Cardiology follow-up notes for Priya";
    const got = extractPdfText(clearTextPdf(text));
    expect(got).toBe(text);
  });

  test("extractPdfText inflates FlateDecode streams and reads Tj operators", () => {
    const text = "Flate compressed PDF text content here";
    const got = extractPdfText(flateTextPdf(text));
    expect(got).toBe(text);
  });

  test("extractPdfText decodes PDF newline escapes in Tj (then collapses whitespace)", () => {
    const text = "Line one\\nLine two with padding!!";
    const got = extractPdfText(clearTextPdf(text));
    expect(got).toBe("Line one Line two with padding!!");
  });

  test("extractPdfText refuses a decompression bomb via maxOutputLength", () => {
    const bomb = deflateSync(Buffer.alloc(8 * 1024 * 1024, 0));
    const dict = `<< /Filter /FlateDecode /Length ${bomb.length} >>`;
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from(`${dict}stream\n`, "latin1"),
      bomb,
      Buffer.from("\nendstream\n", "latin1"),
    ]);
    expect(extractPdfText(pdf)).toBeNull();
  });

  test("extractPdfText skips streams whose compressed size exceeds the 2 MiB cap", () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 100, 0x41);
    const dict = `<< /Filter /FlateDecode /Length ${big.length} >>`;
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from(`${dict}stream\n`, "latin1"),
      big,
      Buffer.from("\nendstream\n", "latin1"),
    ]);
    expect(extractPdfText(pdf)).toBeNull();
  });

  test("extractPdfText ignores streams with non-Flate filters", () => {
    const noTj = Buffer.from("BT hello ET", "latin1");
    const dict = `<< /Filter /DCTDecode /Length ${noTj.length} >>`;
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from(`${dict}stream\n`, "latin1"),
      noTj,
      Buffer.from("\nendstream\n", "latin1"),
    ]);
    expect(extractPdfText(pdf)).toBeNull();
  });
});
