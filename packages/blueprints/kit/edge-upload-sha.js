import { CBSF_MAGIC } from '@centraid/blob-format';

export const FRAME_BYTES = 4 * 1024 * 1024;
export const FRAMES_PER_PART = 4;
export const MAGIC = new TextEncoder().encode(CBSF_MAGIC);
export const FALLBACK_CHUNK_BYTES = 16 * 1024 * 1024;

const SHA_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

export class StreamingSha256 {
  constructor(source) {
    this.words = source ? [...source.words] : [...SHA_INITIAL];
    this.bytes = source?.bytes ?? 0;
    this.pending = source ? source.pending.slice() : new Uint8Array(0);
  }

  update(input) {
    if (input.byteLength === 0) return;
    this.bytes += input.byteLength;
    const joined = new Uint8Array(this.pending.byteLength + input.byteLength);
    joined.set(this.pending);
    joined.set(input, this.pending.byteLength);
    let offset = 0;
    while (joined.byteLength - offset >= 64) {
      this.compress(joined.subarray(offset, offset + 64));
      offset += 64;
    }
    this.pending = joined.slice(offset);
  }

  digestHex() {
    const clone = new StreamingSha256(this);
    const paddingLength =
      clone.pending.byteLength < 56
        ? 56 - clone.pending.byteLength
        : 120 - clone.pending.byteLength;
    const padding = new Uint8Array(paddingLength + 8);
    padding[0] = 0x80;
    new DataView(padding.buffer).setBigUint64(paddingLength, BigInt(clone.bytes) * 8n, false);
    clone.update(padding);
    return clone.words.map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  compress(block) {
    const schedule = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15];
      const b = schedule[index - 2];
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.words;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + SHA_K[index] + schedule[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) {
      this.words[index] = (this.words[index] + next[index]) >>> 0;
    }
  }
}

/** Hash a File with bounded memory; SubtleCrypto has no streaming digest API. */
