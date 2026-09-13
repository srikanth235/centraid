import { describe, expect, it } from "vitest";

import { MAX_FRAME_BYTES } from "./methods.js";
import {
  CHUNK_BYTES,
  chunkCount,
  chunkFrames,
  dataUriBytes,
  encodeChunk,
  MAX_INLINE_BYTES,
  needsStaging,
  sha256Hex,
} from "./stage-core.js";

function payload(size: number): Uint8Array {
  // Not zeroes: a digest over a run of zeroes would pass a splitter that
  // dropped a chunk of them.
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 1) bytes[at] = at % 251;
  return bytes;
}

describe("chunking under the browser's ceiling", () => {
  /*
   * THE 3 MB CASE, which is an ordinary 2× screenshot of a tall page and the
   * reason this layer exists at all.
   */
  it("splits a 3 MB capture into frames that each fit", () => {
    const bytes = payload(3 * 1024 * 1024);
    expect(needsStaging(bytes.length)).toBe(true);
    expect(chunkCount(bytes.length)).toBe(6);
    const frames = chunkFrames("stage-1", bytes);
    expect(frames).toHaveLength(6);
    for (const frame of frames) {
      const encoded = JSON.stringify(frame);
      expect(encoded.length).toBeLessThan(MAX_FRAME_BYTES);
    }
    // AND THE LAST CHUNK IS THE REMAINDER, not a padded window.
    const last = frames.at(-1) as { bytes_b64: string };
    expect(atob(last.bytes_b64)).toHaveLength(bytes.length - 5 * CHUNK_BYTES);
  });

  it("keeps a small capture inline", () => {
    expect(needsStaging(1024)).toBe(false);
    expect(needsStaging(MAX_INLINE_BYTES)).toBe(false);
    expect(needsStaging(MAX_INLINE_BYTES + 1)).toBe(true);
    // The inline bound leaves room for base64 and the envelope, so an inline
    // frame at the bound still fits.
    const frame = JSON.stringify({
      t: "capture:document",
      screenshot: encodeChunk(payload(MAX_INLINE_BYTES)),
    });
    expect(frame.length).toBeLessThan(MAX_FRAME_BYTES);
  });

  it("counts the same chunks the host does", () => {
    expect(chunkCount(0)).toBe(0);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(CHUNK_BYTES)).toBe(1);
    expect(chunkCount(CHUNK_BYTES + 1)).toBe(2);
    expect(chunkCount(3 * 1024 * 1024)).toBe(6);
  });

  it("encodes a window larger than the engine's argument limit", () => {
    // `String.fromCharCode(...bytes)` over 512 KiB overflows the call stack in
    // every engine, and the failure looks like a corrupt capture.
    const bytes = payload(CHUNK_BYTES);
    const encoded = encodeChunk(bytes);
    expect(atob(encoded)).toHaveLength(bytes.length);
  });

  it("round-trips the bytes through the frames", () => {
    const bytes = payload(CHUNK_BYTES * 2 + 17);
    const rebuilt = new Uint8Array(bytes.length);
    let at = 0;
    for (const frame of chunkFrames("stage-1", bytes)) {
      const binary = atob((frame as { bytes_b64: string }).bytes_b64);
      for (let index = 0; index < binary.length; index += 1) {
        rebuilt[at] = binary.charCodeAt(index);
        at += 1;
      }
    }
    expect(at).toBe(bytes.length);
    expect(rebuilt).toStrictEqual(bytes);
  });
});

describe("the capture's own bytes", () => {
  it("reads a PNG data URI and refuses anything else", () => {
    const uri = `data:image/png;base64,${encodeChunk(payload(64))}`;
    expect(dataUriBytes(uri, "image/png")?.bytes).toHaveLength(64);
    expect(dataUriBytes(uri, "image/jpeg")).toBeUndefined();
    expect(dataUriBytes("not a data uri")).toBeUndefined();
    expect(dataUriBytes("data:image/png,notbase64")).toBeUndefined();
  });

  it("digests through the platform rather than by hand", async () => {
    // The empty string's SHA-256, which is a constant anybody can check.
    await expect(sha256Hex(new Uint8Array(0))).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});
