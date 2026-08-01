// Cheap PDF text backstop for the ingress spool. This is deliberately not a
// renderer: it recognizes text-showing operators in clear or Flate-compressed
// content streams, which covers the common born-digital PDF path without
// putting an unbounded document or decompression bomb in gateway memory.

import { inflateSync } from "node:zlib";

const MIB = 1024 * 1024;
const MAX_SCAN_BYTES = 8 * MIB;
const MAX_COMPRESSED_STREAM_BYTES = 2 * MIB;
const MAX_INFLATED_STREAM_BYTES = MIB;
const MAX_TOTAL_INFLATED_BYTES = 4 * MIB;
const MAX_STREAMS = 64;
const MAX_TEXT_PARTS = 5000;
const STREAM_TOKEN = Buffer.from("stream", "ascii");
const END_STREAM_TOKEN = Buffer.from("endstream", "ascii");

/** Extract a bounded useful-text candidate from one PDF byte probe. */
export function extractPdfText(bytes: Buffer): string | null {
  const probe = bytes.subarray(0, Math.min(bytes.length, MAX_SCAN_BYTES));
  const parts = textShowingParts(probe.toString("latin1"));
  let inflatedBytes = 0;
  let cursor = 0;
  let streams = 0;
  while (streams < MAX_STREAMS && parts.length < MAX_TEXT_PARTS) {
    const streamAt = probe.indexOf(STREAM_TOKEN, cursor);
    if (streamAt < 0) break;
    streams += 1;
    cursor = streamAt + STREAM_TOKEN.length;
    const dataStart = streamDataStart(probe, cursor);
    if (dataStart === null) continue;
    const dictionary = streamDictionary(probe, streamAt);
    if (!dictionary || !hasOnlyFlateFilter(dictionary)) continue;
    const compressed = compressedStream(probe, dictionary, dataStart);
    if (!compressed || compressed.length > MAX_COMPRESSED_STREAM_BYTES)
      continue;
    const remaining = MAX_TOTAL_INFLATED_BYTES - inflatedBytes;
    if (remaining <= 0) break;
    try {
      const inflated = inflateSync(compressed, {
        maxOutputLength: Math.min(MAX_INFLATED_STREAM_BYTES, remaining),
      });
      inflatedBytes += inflated.length;
      parts.push(...textShowingParts(inflated.toString("latin1")));
    } catch {
      // Unsupported filters, truncated probes and oversized output are a
      // clean miss. A device/pdf.js enricher may still contribute later.
    }
  }
  const text = parts
    .slice(0, MAX_TEXT_PARTS)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length >= 16 ? text : null;
}

function streamDataStart(bytes: Buffer, afterToken: number): number | null {
  if (bytes[afterToken] === 0x0a) return afterToken + 1;
  if (bytes[afterToken] === 0x0d && bytes[afterToken + 1] === 0x0a)
    return afterToken + 2;
  if (bytes[afterToken] === 0x0d) return afterToken + 1;
  return null;
}

interface StreamDictionary {
  text: string;
  end: number;
}

function streamDictionary(
  bytes: Buffer,
  streamAt: number
): StreamDictionary | null {
  const floor = Math.max(0, streamAt - 64 * 1024);
  const end = bytes.lastIndexOf(Buffer.from(">>", "ascii"), streamAt - 1);
  if (end < floor) return null;
  const start = bytes.lastIndexOf(Buffer.from("<<", "ascii"), end - 1);
  if (start < floor) return null;
  return { text: bytes.toString("latin1", start, end + 2), end: end + 2 };
}

function hasOnlyFlateFilter(dictionary: StreamDictionary): boolean {
  return /\/Filter\s*(?:\/(?:FlateDecode|Fl)\b|\[\s*\/(?:FlateDecode|Fl)\s*\])/u.test(
    dictionary.text
  );
}

function compressedStream(
  bytes: Buffer,
  dictionary: StreamDictionary,
  dataStart: number
): Buffer | null {
  const lengthMatch = /\/Length\s+(?<streamLength>\d+)\b/u.exec(
    dictionary.text
  );
  if (lengthMatch) {
    const length = Number(lengthMatch.groups?.streamLength);
    if (
      Number.isSafeInteger(length) &&
      length >= 0 &&
      dataStart + length <= bytes.length
    ) {
      return bytes.subarray(dataStart, dataStart + length);
    }
  }
  const end = bytes.indexOf(END_STREAM_TOKEN, dataStart);
  if (end < 0) return null;
  let payloadEnd = end;
  if (bytes[payloadEnd - 1] === 0x0a) payloadEnd -= 1;
  if (bytes[payloadEnd - 1] === 0x0d) payloadEnd -= 1;
  return bytes.subarray(dataStart, payloadEnd);
}

/**
 * Collect PDF string operands of Tj / TJ operators without nested-quantifier
 * regexes (Sonar S5852 / ReDoS). Literals and bracket arrays are walked in
 * linear time with explicit escape handling.
 */
function textShowingParts(raw: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < raw.length && parts.length < MAX_TEXT_PARTS) {
    if (raw[i] === "(") {
      const literal = readPdfLiteral(raw, i);
      if (!literal) {
        i += 1;
        continue;
      }
      const after = skipPdfWs(raw, literal.end);
      if (raw.startsWith("Tj", after)) {
        parts.push(decodePdfString(literal.value));
        i = after + 2;
        continue;
      }
      i = literal.end;
      continue;
    }
    if (raw[i] === "[") {
      const close = findPdfArrayClose(raw, i);
      if (close < 0) {
        i += 1;
        continue;
      }
      const after = skipPdfWs(raw, close + 1);
      if (raw.startsWith("TJ", after)) {
        pushLiteralsFromSlice(raw, i + 1, close, parts);
        i = after + 2;
        continue;
      }
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return parts;
}

function skipPdfWs(raw: string, from: number): number {
  let i = from;
  while (i < raw.length && /\s/u.test(raw[i]!)) i += 1;
  return i;
}

/** Read a `(...)` PDF string starting at `open` (`(`). */
function readPdfLiteral(
  raw: string,
  open: number
): { value: string; end: number } | null {
  if (raw[open] !== "(") return null;
  let i = open + 1;
  let depth = 1;
  let value = "";
  while (i < raw.length && depth > 0) {
    const c = raw[i]!;
    if (c === "\\") {
      value += c + (raw[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "(") {
      depth += 1;
      value += c;
      i += 1;
      continue;
    }
    if (c === ")") {
      depth -= 1;
      if (depth === 0) return { value, end: i + 1 };
      value += c;
      i += 1;
      continue;
    }
    value += c;
    i += 1;
  }
  return null;
}

/** Matching `]` for a `[` at `open`, skipping nested PDF string literals. */
function findPdfArrayClose(raw: string, open: number): number {
  let i = open + 1;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === "(") {
      const lit = readPdfLiteral(raw, i);
      if (!lit) return -1;
      i = lit.end;
      continue;
    }
    if (c === "]") return i;
    // Nested arrays are rare in TJ operands; still skip them linearly.
    if (c === "[") {
      const nested = findPdfArrayClose(raw, i);
      if (nested < 0) return -1;
      i = nested + 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

function pushLiteralsFromSlice(
  raw: string,
  from: number,
  to: number,
  parts: string[]
): void {
  let i = from;
  while (i < to && parts.length < MAX_TEXT_PARTS) {
    if (raw[i] === "(") {
      const lit = readPdfLiteral(raw, i);
      if (!lit || lit.end > to) break;
      parts.push(decodePdfString(lit.value));
      i = lit.end;
      continue;
    }
    i += 1;
  }
}

function decodePdfString(value: string): string {
  return value
    .replace(/\\(?<char>[nrtbf()\\])/gu, (_, char: string) =>
      char === "n"
        ? "\n"
        : char === "r"
          ? "\r"
          : char === "t"
            ? "\t"
            : char === "b" || char === "f"
              ? ""
              : char
    )
    .replace(/\\(?<octal>\d{1,3})/gu, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8))
    );
}
