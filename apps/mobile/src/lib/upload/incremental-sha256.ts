// Incremental SHA-256 for React Native (#419 M0.4).
//
// A port of `packages/vault/src/blob/incremental-sha256.ts` onto Uint8Array:
// that module is Buffer-based and pulls in node builtins, so it cannot be
// imported from Hermes. `expo-crypto` only exposes a one-shot digest, which
// would force a whole 4 GB video into RAM to address it. The algorithm and
// block processing are identical — `incremental-sha256.test.ts` pins this
// against `node:crypto` byte-for-byte, including across chunk boundaries.

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class IncrementalSha256 {
  private readonly words: number[] = [...INITIAL];
  /** Reused for every block; a 4 GB file must not allocate one array per 64 bytes. */
  private readonly schedule = new Uint32Array(64);
  private bytes = 0;
  private pending = new Uint8Array(0);

  update(input: Uint8Array): this {
    if (input.byteLength === 0) return this;
    this.bytes += input.byteLength;
    const joined = this.pending.byteLength === 0 ? input : concat(this.pending, input);
    let offset = 0;
    while (joined.byteLength - offset >= 64) {
      this.compress(joined.subarray(offset, offset + 64));
      offset += 64;
    }
    this.pending = joined.slice(offset);
    return this;
  }

  digestHex(): string {
    // Padding is applied to a clone so `update` may still be called after a
    // caller peeks at the digest.
    const clone = new IncrementalSha256();
    clone.words.splice(0, 8, ...this.words);
    clone.bytes = this.bytes;
    clone.pending = this.pending.slice();
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

  private compress(block: Uint8Array): void {
    const schedule = this.schedule;
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const a = schedule[i - 15]!;
      const b = schedule[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      schedule[i] = (schedule[i - 16]! + s0 + schedule[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.words as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + K[i]! + schedule[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
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
    for (let i = 0; i < 8; i += 1) this.words[i] = (this.words[i]! + next[i]!) >>> 0;
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
}
