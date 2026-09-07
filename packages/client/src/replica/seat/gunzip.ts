// GUNZIP, IN JS, FOR THE SEAT THAT HAS NO ZLIB (#996, wave 4b).
//
// The snapshot door serves the artifact as a gzip BODY, not as a transfer
// encoding (`seat-routes.ts:129`), and deliberately: `Content-Encoding` would
// let a proxy or a fetch implementation decompress underneath the seat, and
// then a byte range means something different at each end and a resume splices
// two files together. That decision is what makes the download resumable, and
// it is also why the seat must do the decompressing itself.
//
// The browser and the desktop have zlib to hand (`node:zlib`,
// `DecompressionStream`). Hermes has neither, and reaching for a compression
// package would put a third-party inflate in the one code path where being
// wrong produces a database file that opens and is subtly corrupt. So it is
// here, it is RFC 1951 plus the RFC 1952 container and nothing else, and it is
// pinned by a fuzz round-trip against `node:zlib`'s own gzip output.

import { Bits } from "./gunzip-bits.js";
import { Output } from "./gunzip-output.js";

/**
 * A canonical Huffman decoder as its code-length table.
 *
 * Decoded bit by bit against `first`/`count` per length rather than through a
 * lookup table: the table is the faster shape and the slower one is the one
 * whose correctness can be read off the RFC, and this runs once per bootstrap.
 */
class Huffman {
  private readonly counts: number[] = [];
  private readonly symbols: number[] = [];

  constructor(lengths: readonly number[]) {
    const maxBits = 15;
    for (let index = 0; index <= maxBits; index += 1) this.counts[index] = 0;
    for (const length of lengths)
      this.counts[length] = (this.counts[length] ?? 0) + 1;
    this.counts[0] = 0;
    const offsets: number[] = [0, 0];
    for (let length = 1; length <= maxBits; length += 1)
      offsets[length + 1] = (offsets[length] ?? 0) + (this.counts[length] ?? 0);
    for (const [symbol, length] of lengths.entries()) {
      if (length === 0) continue;
      const at = offsets[length] ?? 0;
      this.symbols[at] = symbol;
      offsets[length] = at + 1;
    }
  }

  decode(bits: Bits): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= 15; length += 1) {
      code += bits.bit();
      const count = this.counts[length] ?? 0;
      if (code - first < count) {
        const symbol = this.symbols[index + (code - first)];
        if (symbol === undefined) throw new Error("gunzip: bad Huffman code");
        return symbol;
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("gunzip: Huffman code longer than 15 bits");
  }
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
] as const;
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
] as const;
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12_289, 16_385, 24_577,
] as const;
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
] as const;
const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
] as const;

function fixedLiteralLengths(): number[] {
  const lengths: number[] = [];
  for (let symbol = 0; symbol < 288; symbol += 1)
    lengths.push(symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8);
  return lengths;
}

function dynamicTables(bits: Bits): [Huffman, Huffman] {
  const literals = bits.bits(5) + 257;
  const distances = bits.bits(5) + 1;
  const codes = bits.bits(4) + 4;
  const codeLengths = Array.from({ length: 19 }, () => 0);
  for (let index = 0; index < codes; index += 1)
    codeLengths[CODE_LENGTH_ORDER[index] ?? 0] = bits.bits(3);
  const codeTable = new Huffman(codeLengths);
  const lengths: number[] = [];
  while (lengths.length < literals + distances) {
    const symbol = codeTable.decode(bits);
    if (symbol < 16) {
      lengths.push(symbol);
      continue;
    }
    let repeat: number;
    let value = 0;
    if (symbol === 16) {
      value = lengths.at(-1) ?? -1;
      if (value < 0) throw new Error("gunzip: repeat with no previous length");
      repeat = bits.bits(2) + 3;
    } else if (symbol === 17) repeat = bits.bits(3) + 3;
    else repeat = bits.bits(7) + 11;
    for (let index = 0; index < repeat; index += 1) lengths.push(value);
  }
  return [
    new Huffman(lengths.slice(0, literals)),
    new Huffman(lengths.slice(literals)),
  ];
}

function inflateBlock(
  bits: Bits,
  out: Output,
  literal: Huffman,
  distance: Huffman
): void {
  for (;;) {
    const symbol = literal.decode(bits);
    if (symbol === 256) return;
    if (symbol < 256) {
      out.push(symbol);
      continue;
    }
    const index = symbol - 257;
    const base = LENGTH_BASE[index];
    if (base === undefined) throw new Error("gunzip: bad length symbol");
    const length = base + bits.bits(LENGTH_EXTRA[index] ?? 0);
    const distanceSymbol = distance.decode(bits);
    const distanceBase = DISTANCE_BASE[distanceSymbol];
    if (distanceBase === undefined)
      throw new Error("gunzip: bad distance symbol");
    out.back(
      distanceBase + bits.bits(DISTANCE_EXTRA[distanceSymbol] ?? 0),
      length
    );
  }
}

/** Raw DEFLATE (RFC 1951). */
export function inflateRaw(
  source: Uint8Array,
  hint = source.length * 4
): Uint8Array {
  const bits = new Bits(source);
  const out = new Output(hint);
  let last = false;
  while (!last) {
    last = bits.bit() === 1;
    const type = bits.bits(2);
    if (type === 0) {
      bits.align();
      const at = bits.bytePosition;
      const length = (source[at] ?? 0) | ((source[at + 1] ?? 0) << 8);
      const complement = (source[at + 2] ?? 0) | ((source[at + 3] ?? 0) << 8);
      if ((length ^ 0xff_ff) !== complement)
        throw new Error(
          "gunzip: stored block length does not match its complement"
        );
      out.copy(source.subarray(at + 4, at + 4 + length));
      bits.seek(at + 4 + length);
      continue;
    }
    if (type === 1) {
      inflateBlock(
        bits,
        out,
        new Huffman(fixedLiteralLengths()),
        new Huffman(Array.from({ length: 30 }, () => 5))
      );
      continue;
    }
    if (type === 2) {
      const [literal, distance] = dynamicTables(bits);
      inflateBlock(bits, out, literal, distance);
      continue;
    }
    throw new Error("gunzip: reserved block type");
  }
  return out.take();
}

/**
 * One gzip member (RFC 1952).
 *
 * The CRC is NOT checked here and that is deliberate: the seat's integrity
 * claim is the door's strong ETag over the whole artifact plus SQLite's own
 * page checksums after the install, and a second 64 MB pass on a phone to
 * re-derive a number the transport already stood behind is a battery cost with
 * no new failure it can catch. A truncated download is caught by the byte
 * count before this is ever called (`bootstrap.ts`).
 */
export function gunzip(source: Uint8Array): Uint8Array {
  if (source[0] !== 0x1f || source[1] !== 0x8b)
    throw new Error("gunzip: not a gzip artifact");
  if (source[2] !== 8)
    throw new Error("gunzip: unsupported compression method");
  const flags = source[3] ?? 0;
  let at = 10;
  if (flags & 0b100)
    at += 2 + ((source[at] ?? 0) | ((source[at + 1] ?? 0) << 8));
  const skipString = (): void => {
    while ((source[at] ?? 0) !== 0) at += 1;
    at += 1;
  };
  if (flags & 0b1000) skipString();
  if (flags & 0b1_0000) skipString();
  if (flags & 0b10) at += 2;
  // ISIZE is the uncompressed size mod 2^32 — a hint for the first allocation,
  // never a length to trust: the artifact is bigger than 4 GB at no volume we
  // serve, but `Output` grows regardless of what this says.
  return inflateRaw(source.subarray(at), readSize(source) || source.length * 4);
}

function readSize(source: Uint8Array): number {
  const at = source.length - 4;
  return (
    ((source[at] ?? 0) |
      ((source[at + 1] ?? 0) << 8) |
      ((source[at + 2] ?? 0) << 16) |
      ((source[at + 3] ?? 0) << 24)) >>>
    0
  );
}
