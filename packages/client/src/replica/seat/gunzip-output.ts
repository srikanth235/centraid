// THE INFLATE OUTPUT BUFFER (#996, wave 4b; see `gunzip.ts`).

/** Grows by doubling: the gzip footer's ISIZE is mod 2^32 and cannot be trusted for a 64 MB file. */
export class Output {
  #bytes: Uint8Array;
  #length = 0;

  constructor(hint: number) {
    this.#bytes = new Uint8Array(Math.max(hint, 1024));
  }

  get length(): number {
    return this.#length;
  }

  push(byte: number): void {
    this.reserve(1);
    this.#bytes[this.#length] = byte;
    this.#length += 1;
  }

  copy(source: Uint8Array): void {
    this.reserve(source.length);
    this.#bytes.set(source, this.#length);
    this.#length += source.length;
  }

  /** LZ77 back-reference; overlapping copies are the common case, byte at a time. */
  back(distance: number, length: number): void {
    if (distance > this.#length)
      throw new Error("gunzip: distance before start of stream");
    this.reserve(length);
    let from = this.#length - distance;
    for (let index = 0; index < length; index += 1) {
      this.#bytes[this.#length] = this.#bytes[from] ?? 0;
      this.#length += 1;
      from += 1;
    }
  }

  take(): Uint8Array {
    return this.#bytes.subarray(0, this.#length);
  }

  private reserve(more: number): void {
    if (this.#length + more <= this.#bytes.length) return;
    let size = this.#bytes.length * 2;
    while (size < this.#length + more) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
  }
}
