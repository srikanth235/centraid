// Serializable incremental SHA-256 for restart-resumable ingress (#456 C6).
//
// `node:crypto` is the ordinary native streaming path, but Node deliberately
// does not expose Hash state. The stream-through uploader must checkpoint its
// chaining state after each durable multipart part, so this narrow seam uses
// hash-wasm: hashing executes in WebAssembly and `save()` snapshots the
// hasher's linear-memory state. This retires the previous handwritten
// JavaScript compressor while keeping the durable resume contract.

import { createSHA256, type IHasher } from 'hash-wasm';

export interface SerializableSha256State {
  version: 2;
  wasmBase64: string;
}

export class IncrementalSha256 {
  private constructor(private readonly hasher: IHasher) {}

  static async create(state?: SerializableSha256State): Promise<IncrementalSha256> {
    const hasher = await createSHA256();
    if (state) {
      if (state.version !== 2 || typeof state.wasmBase64 !== 'string') {
        throw new Error('invalid serialized SHA-256 state');
      }
      try {
        hasher.load(Buffer.from(state.wasmBase64, 'base64'));
      } catch {
        throw new Error('invalid serialized SHA-256 state');
      }
    }
    return new IncrementalSha256(hasher);
  }

  update(input: Uint8Array): this {
    this.hasher.update(input);
    return this;
  }

  exportState(): SerializableSha256State {
    return { version: 2, wasmBase64: Buffer.from(this.hasher.save()).toString('base64') };
  }

  /** Digest a state clone so callers may continue appending after verification. */
  async digestHex(): Promise<string> {
    const clone = await createSHA256();
    clone.load(this.hasher.save());
    return clone.digest('hex');
  }
}
