import { File as NodeFile } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256File, sha256FileStream, StreamingSha256 } from "./sha256.js";

describe("streaming sha-256", () => {
  it("hashes a streamed file without materializing it through SubtleCrypto", async () => {
    const bytes = Buffer.from("device-preferred hashing");
    const file = new NodeFile([bytes], "hash.txt") as unknown as File;
    await expect(sha256FileStream(file)).resolves.toBe(
      createHash("sha256").update(bytes).digest("hex")
    );
  });

  it("agrees with a one-shot digest across the 64-byte block boundary", () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 200]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 7) % 256);
      const hash = new StreamingSha256();
      for (let at = 0; at < size; at += 17)
        hash.update(bytes.subarray(at, Math.min(size, at + 17)));
      expect(hash.digestHex(), `${size} bytes`).toBe(
        createHash("sha256").update(bytes).digest("hex")
      );
    }
  });

  it("digests without consuming the state, so an update may follow", () => {
    const hash = new StreamingSha256();
    hash.update(new TextEncoder().encode("ab"));
    const first = hash.digestHex();
    expect(hash.digestHex()).toBe(first);
    hash.update(new TextEncoder().encode("c"));
    expect(hash.digestHex()).toBe(
      createHash("sha256").update("abc").digest("hex")
    );
  });

  it("declines a value that cannot be read as a File rather than throwing", async () => {
    await expect(sha256File({} as File)).resolves.toBeNull();
  });

  it("falls back to arrayBuffer() when the File exposes no stream", async () => {
    const bytes = new TextEncoder().encode("no stream here");
    const fileLike = {
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
    await expect(sha256File(fileLike)).resolves.toBe(
      createHash("sha256").update(bytes).digest("hex")
    );
  });
});
// @vitest-environment jsdom
