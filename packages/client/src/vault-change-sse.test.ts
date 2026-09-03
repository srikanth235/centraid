import { describe, expect, it } from "vitest";

import {
  consumeVaultChangeSse,
  MAX_BUFFERED_FRAME_BYTES,
  VaultChangeStreamError,
} from "./vault-change-sse.js";
import type { SseFrame } from "./vault-change-sse.js";

const CHUNK_BYTES = 64 * 1024;

function chunkedBody(chunks: () => Generator<string>): {
  body: ReadableStream<Uint8Array>;
  wasCancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  const source = chunks();
  let cancelled = false;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = source.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      cancel() {
        cancelled = true;
      },
    }),
    wasCancelled: () => cancelled,
  };
}

function* slices(text: string): Generator<string> {
  for (let at = 0; at < text.length; at += CHUNK_BYTES)
    yield text.slice(at, at + CHUNK_BYTES);
}

function changePageFrame(): string {
  const changes = Array.from({ length: 1_000 }, (_unused, index) => ({
    seq: index + 1,
    commitId: `commit-${String(index).padStart(12, "0")}`,
    entity: "photos_asset",
    rowId: `01J8ZQ9K7Y0000000000000${String(index).padStart(3, "0")}`,
    op: "update",
    changedAt: "2026-08-27T10:11:12.000Z",
    shapeIds: Array.from(
      { length: 8 },
      (_shape, shapeIndex) => `photos:asset:shape-${shapeIndex}`
    ),
  }));
  return JSON.stringify({ changes, cursor: { epoch: "e1", seq: 1_000 } });
}

describe(consumeVaultChangeSse, () => {
  it("fails a stream that outgrows the frame bound without a boundary", async () => {
    const filler = "x".repeat(CHUNK_BYTES);
    const overflowChunks =
      Math.ceil(MAX_BUFFERED_FRAME_BYTES / CHUNK_BYTES) + 1;
    const stream = chunkedBody(function* () {
      yield "event: change\ndata: ";
      for (let sent = 0; sent < overflowChunks; sent++) yield filler;
    });
    const frames: SseFrame[] = [];

    await expect(
      consumeVaultChangeSse(stream.body, (frame) => frames.push(frame))
    ).rejects.toThrow(VaultChangeStreamError);

    expect(frames).toStrictEqual([]);
    expect(stream.wasCancelled()).toBe(true);
  });

  it("parses a full change page delivered in chunks under the bound", async () => {
    const page = changePageFrame();
    expect(page.length).toBeGreaterThan(256 * 1024);
    expect(page.length).toBeLessThan(MAX_BUFFERED_FRAME_BYTES);
    const stream = chunkedBody(function* () {
      yield* slices(`event: change\ndata: ${page}`);
      yield "\n\n";
    });
    const frames: SseFrame[] = [];

    await consumeVaultChangeSse(stream.body, (frame) => frames.push(frame));

    expect(frames).toStrictEqual([{ event: "change", data: page }]);
  });

  it("bounds the incomplete tail, not the stream's lifetime traffic", async () => {
    const body = "y".repeat(CHUNK_BYTES);
    const frameCount = Math.ceil(MAX_BUFFERED_FRAME_BYTES / CHUNK_BYTES) + 1;
    const stream = chunkedBody(function* () {
      for (let sent = 0; sent < frameCount; sent++)
        yield `event: change\ndata: ${body}\n\n`;
    });
    let received = 0;

    await consumeVaultChangeSse(stream.body, () => {
      received++;
    });

    expect(frameCount * CHUNK_BYTES).toBeGreaterThan(MAX_BUFFERED_FRAME_BYTES);
    expect(received).toBe(frameCount);
    expect(stream.wasCancelled()).toBe(false);
  });
});
