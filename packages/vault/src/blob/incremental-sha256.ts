import { createSHA256 } from "hash-wasm";
import type { IHasher } from "hash-wasm";

export interface SerializableSha256State {
  version: 2;
  wasmBase64: string;
}

export class IncrementalSha256 {
  private constructor(private readonly hasher: IHasher) {}

  static async create(
    state?: SerializableSha256State
  ): Promise<IncrementalSha256> {
    const hasher = await createSHA256();
    if (state) {
      if (state.version !== 2 || typeof state.wasmBase64 !== "string") {
        throw new Error("invalid serialized SHA-256 state");
      }
      try {
        hasher.load(Buffer.from(state.wasmBase64, "base64"));
      } catch {
        throw new Error("invalid serialized SHA-256 state");
      }
    }
    return new IncrementalSha256(hasher);
  }

  update(input: Uint8Array): this {
    this.hasher.update(input);
    return this;
  }

  exportState(): SerializableSha256State {
    return {
      version: 2,
      wasmBase64: Buffer.from(this.hasher.save()).toString("base64"),
    };
  }

  async digestHex(): Promise<string> {
    const clone = await createSHA256();
    clone.load(this.hasher.save());
    return clone.digest("hex");
  }
}
