// THE BIT READER (#996, wave 4b; see `gunzip.ts` for why this exists at all).
//
// LSB-first within a byte, which is DEFLATE's order and the opposite of the
// one a stored block's little-endian length field is read in — hence `align`
// and `seek`, which hand the byte position back and take it again.

/** Bit reader over the compressed stream, LSB-first as DEFLATE specifies. */
export class Bits {
  #byte = 0;
  #bit = 0;

  constructor(private readonly source: Uint8Array) {}

  /** Byte position, rounded up past a partly-read byte. */
  get bytePosition(): number {
    return this.#bit === 0 ? this.#byte : this.#byte + 1;
  }

  align(): void {
    if (this.#bit !== 0) {
      this.#byte += 1;
      this.#bit = 0;
    }
  }

  seek(byte: number): void {
    this.#byte = byte;
    this.#bit = 0;
  }

  bit(): number {
    const source = this.source[this.#byte];
    if (source === undefined) throw new Error("gunzip: stream ended mid-block");
    const value = (source >> this.#bit) & 1;
    this.#bit += 1;
    if (this.#bit === 8) {
      this.#bit = 0;
      this.#byte += 1;
    }
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) value += this.bit() << index;
    return value;
  }
}
