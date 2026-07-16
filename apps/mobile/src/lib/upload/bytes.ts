// Byte helpers for the CBSF sealer (#419 M0.4).
//
// Hermes has no Buffer and its `atob`/`btoa` coverage is inconsistent across
// RN releases, so base64 is implemented here rather than assumed. Everything
// is Uint8Array + DataView, which both Hermes and node agree on.

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function u64be(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) throw new Error('invalid hex');
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!;
    const b = bytes[offset + 1];
    const c = bytes[offset + 2];
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : BASE64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : BASE64_ALPHABET[c & 63];
  }
  return out;
}

export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/[\n\r=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let accumulator = 0;
  let written = 0;
  for (const char of clean) {
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('invalid base64');
    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (accumulator >> bits) & 0xff;
    }
  }
  return out.subarray(0, written);
}
