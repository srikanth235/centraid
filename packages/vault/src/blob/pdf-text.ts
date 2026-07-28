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
  let i = 0;
  while (i < raw.length && parts.length < MAX_TEXT_PARTS) {
    // Look for Tj string — (...)
    if (raw[i] === '(') {
      i++;
      let depth = 1;
      let escaped = false;
      const start = i;
      while (i < raw.length && depth > 0) {
        if (escaped) {
          escaped = false;
        } else if (raw[i] === '\\') {
          escaped = true;
        } else if (raw[i] === '(') {
          depth++;
        } else if (raw[i] === ')') {
          depth--;
        }
        if (depth > 0) i++;
      }
      if (depth === 0) {
        const content = raw.slice(start, i);
        i++;
        // Skip optional whitespace then Tj
        let j = i;
        while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
        if (raw.slice(j, j + 2) === 'Tj') {
          parts.push(decodePdfString(content));
          i = j + 2;
          continue;
        }
      }
      continue;
    }
    // Look for TJ array — [...]
    if (raw[i] === '[') {
      i++;
      const arrStart = i;
      let depth = 1;
      while (i < raw.length && depth > 0) {
        if (raw[i] === '[') depth++;
        else if (raw[i] === ']') depth--;
        if (depth > 0) i++;
      }
      if (depth === 0) {
        const arrContent = raw.slice(arrStart, i);
        i++;
        // Skip optional whitespace then TJ
        let j = i;
        while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
        if (raw.slice(j, j + 2) === 'TJ') {
          // Extract parenthesized strings from the array
          let k = 0;
          while (k < arrContent.length && parts.length < MAX_TEXT_PARTS) {
            if (arrContent[k] === '(') {
              k++;
              let d2 = 1;
              let esc2 = false;
              const s2 = k;
              while (k < arrContent.length && d2 > 0) {
                if (esc2) {
                  esc2 = false;
                } else if (arrContent[k] === '\\') {
                  esc2 = true;
                } else if (arrContent[k] === '(') {
                  d2++;
                } else if (arrContent[k] === ')') {
                  d2--;
                }
                if (d2 > 0) k++;
              }
              if (d2 === 0) {
                parts.push(decodePdfString(arrContent.slice(s2, k)));
                k++;
              }
            } else {
              k++;
            }
          }
          i = j + 2;
          continue;
        }
      }
      continue;
    }
    i++;
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
