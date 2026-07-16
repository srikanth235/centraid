// Cheap PDF text backstop for the ingress spool. This is deliberately not a
// renderer: it recognizes text-showing operators in clear or Flate-compressed
// content streams, which covers the common born-digital PDF path without
// putting an unbounded document or decompression bomb in gateway memory.

import { inflateSync } from 'node:zlib';

const MIB = 1024 * 1024;
const MAX_SCAN_BYTES = 8 * MIB;
const MAX_COMPRESSED_STREAM_BYTES = 2 * MIB;
const MAX_INFLATED_STREAM_BYTES = MIB;
const MAX_TOTAL_INFLATED_BYTES = 4 * MIB;
const MAX_STREAMS = 64;
const MAX_TEXT_PARTS = 5000;
const STREAM_TOKEN = Buffer.from('stream', 'ascii');
const END_STREAM_TOKEN = Buffer.from('endstream', 'ascii');

/** Extract a bounded useful-text candidate from one PDF byte probe. */
export function extractPdfText(bytes: Buffer): string | null {
  const probe = bytes.subarray(0, Math.min(bytes.length, MAX_SCAN_BYTES));
  const parts = textShowingParts(probe.toString('latin1'));
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
    if (!compressed || compressed.length > MAX_COMPRESSED_STREAM_BYTES) continue;
    const remaining = MAX_TOTAL_INFLATED_BYTES - inflatedBytes;
    if (remaining <= 0) break;
    try {
      const inflated = inflateSync(compressed, {
        maxOutputLength: Math.min(MAX_INFLATED_STREAM_BYTES, remaining),
      });
      inflatedBytes += inflated.length;
      parts.push(...textShowingParts(inflated.toString('latin1')));
    } catch {
      // Unsupported filters, truncated probes and oversized output are a
      // clean miss. A device/pdf.js enricher may still contribute later.
    }
  }
  const text = parts.slice(0, MAX_TEXT_PARTS).join(' ').replace(/\s+/g, ' ').trim();
  return text.length >= 16 ? text : null;
}

function streamDataStart(bytes: Buffer, afterToken: number): number | null {
  if (bytes[afterToken] === 0x0a) return afterToken + 1;
  if (bytes[afterToken] === 0x0d && bytes[afterToken + 1] === 0x0a) return afterToken + 2;
  if (bytes[afterToken] === 0x0d) return afterToken + 1;
  return null;
}

interface StreamDictionary {
  text: string;
  end: number;
}

function streamDictionary(bytes: Buffer, streamAt: number): StreamDictionary | null {
  const floor = Math.max(0, streamAt - 64 * 1024);
  const end = bytes.lastIndexOf(Buffer.from('>>', 'ascii'), streamAt - 1);
  if (end < floor) return null;
  const start = bytes.lastIndexOf(Buffer.from('<<', 'ascii'), end - 1);
  if (start < floor) return null;
  return { text: bytes.toString('latin1', start, end + 2), end: end + 2 };
}

function hasOnlyFlateFilter(dictionary: StreamDictionary): boolean {
  return /\/Filter\s*(?:\/(?:FlateDecode|Fl)\b|\[\s*\/(?:FlateDecode|Fl)\s*\])/.test(
    dictionary.text,
  );
}

function compressedStream(
  bytes: Buffer,
  dictionary: StreamDictionary,
  dataStart: number,
): Buffer | null {
  const lengthMatch = /\/Length\s+(\d+)\b/.exec(dictionary.text);
  if (lengthMatch) {
    const length = Number(lengthMatch[1]);
    if (Number.isSafeInteger(length) && length >= 0 && dataStart + length <= bytes.length) {
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

function textShowingParts(raw: string): string[] {
  const parts: string[] = [];
  for (const match of raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    parts.push(decodePdfString(match[1] ?? ''));
    if (parts.length >= MAX_TEXT_PARTS) return parts;
  }
  for (const match of raw.matchAll(/\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ/g)) {
    for (const value of (match[1] ?? '').matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      parts.push(decodePdfString(value[1] ?? ''));
      if (parts.length >= MAX_TEXT_PARTS) return parts;
    }
  }
  return parts;
}

function decodePdfString(value: string): string {
  return value
    .replace(/\\([nrtbf()\\])/g, (_, char: string) =>
      char === 'n'
        ? '\n'
        : char === 'r'
          ? '\r'
          : char === 't'
            ? '\t'
            : char === 'b' || char === 'f'
              ? ''
              : char,
    )
    .replace(/\\(\d{1,3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}
