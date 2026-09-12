/*
 * The streaming half of the media door, with a fake seat.
 *
 * `media-protocol.ts` imports `electron` for `protocol`, so only the functions
 * that do not touch it are exercised here — `readWindow`, `windowStream` and
 * `refusalToAnswer` — which is the whole of the "one resolved range becomes N
 * frames" arithmetic. The `protocol.handle` wiring is covered by the Playwright
 * run, where a real `<video>` is the assertion.
 */

import { describe, expect, it } from "vitest";

import { readWindow, refusalToAnswer, windowStream } from "./media-protocol.js";
import type { MediaSeat, Window_ } from "./media-protocol.js";
import type { SeatMessage } from "./seat-client-core.js";

const DIGEST = "d".repeat(64);

/** A seat over an in-memory blob, with the frame ceiling the real one has. */
function fakeSeat(options: {
  bytes: Uint8Array;
  total?: number;
  chunk?: number;
  complete?: boolean;
  mediaType?: string;
  /** Ranges that answer `still-arriving` however long the caller waits. */
  stalledFrom?: number;
}): MediaSeat & { calls: string[] } {
  const chunk = options.chunk ?? 16;
  const total = options.total ?? options.bytes.length;
  const calls: string[] = [];
  return {
    calls,
    request: async (message): Promise<SeatMessage> => {
      if (message["t"] === "blob_stat") {
        return {
          t: "blob_stat",
          total,
          received: options.bytes.length,
          complete: options.complete ?? true,
          media_type: options.mediaType ?? "video/webm",
          inline: true,
        };
      }
      const header = message["range"] as string | undefined;
      calls.push(header ?? "<none>");
      const match = /^bytes=(?<from>\d*)-(?<to>\d*)$/u.exec(
        header ?? "bytes=0-"
      );
      if (!match)
        throw Object.assign(new Error("unsatisfiable"), {
          code: "unsatisfiable",
        });
      const from = match.groups?.["from"] ?? "";
      const to = match.groups?.["to"] ?? "";
      const start = from === "" ? 0 : Number(from);
      const reqEnd = to === "" ? total - 1 : Math.min(Number(to), total - 1);
      if (options.stalledFrom !== undefined && start >= options.stalledFrom) {
        throw Object.assign(
          new Error(`still-arriving: ${options.bytes.length}/${total}`),
          { code: "still-arriving" }
        );
      }
      if (start >= options.bytes.length) {
        throw Object.assign(
          new Error(`still-arriving: ${options.bytes.length}/${total}`),
          {
            code: "still-arriving",
          }
        );
      }
      const end = Math.min(reqEnd, start + chunk - 1, options.bytes.length - 1);
      return {
        t: "blob_bytes",
        start,
        end,
        req_end: reqEnd,
        total,
        complete: options.complete ?? true,
        partial: header !== undefined,
        bytes_b64: Buffer.from(options.bytes.slice(start, end + 1)).toString(
          "base64"
        ),
      };
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    // A stream is read one chunk at a time by definition; `Promise.all` has
    // nothing to parallelise here.
    // oxlint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

const body = Uint8Array.from({ length: 100 }, (_value, index) => index);

describe("one resolved range becomes as many frames as it takes", () => {
  it("streams the whole range, in order, with no gap and no repeat", async () => {
    const seat = fakeSeat({ bytes: body, chunk: 16 });
    const first = await readWindow(seat, {
      digest: DIGEST,
      range: undefined,
      waitMs: 1,
    });
    // The first window is ONE frame, and it says the range it resolved.
    expect(first.start).toBe(0);
    expect(first.end).toBe(15);
    expect(first.reqEnd).toBe(99);
    await expect(
      drain(windowStream(seat, { digest: DIGEST, first }))
    ).resolves.toStrictEqual(body);
    // Seven windows for a hundred bytes at sixteen a frame.
    expect(seat.calls).toStrictEqual([
      "<none>",
      "bytes=16-99",
      "bytes=32-99",
      "bytes=48-99",
      "bytes=64-99",
      "bytes=80-99",
      "bytes=96-99",
    ]);
  });

  it("streams a sub-range and stops at its end, not the blob's", async () => {
    const seat = fakeSeat({ bytes: body, chunk: 16 });
    const first = await readWindow(seat, {
      digest: DIGEST,
      range: "bytes=40-59",
      waitMs: 1,
    });
    expect(first.reqEnd).toBe(59);
    expect(first.partial).toBe(true);
    const streamed = await drain(windowStream(seat, { digest: DIGEST, first }));
    expect(Array.from(streamed)).toStrictEqual(Array.from(body.slice(40, 60)));
    expect(seat.calls).toStrictEqual(["bytes=40-59", "bytes=56-59"]);
  });

  it("needs no second frame when the first one covered the range", async () => {
    const seat = fakeSeat({ bytes: body, chunk: 16 });
    const first = await readWindow(seat, {
      digest: DIGEST,
      range: "bytes=0-7",
      waitMs: 1,
    });
    await expect(
      drain(windowStream(seat, { digest: DIGEST, first }))
    ).resolves.toHaveLength(8);
    expect(seat.calls).toStrictEqual(["bytes=0-7"]);
  });

  /**
   * A short read on a media element is a retry; a zero-padded one is a corrupt
   * frame it will never ask about again. So the stream ERRORS.
   */
  it("errors the stream rather than padding it when the blob stops arriving", async () => {
    const arrived = body.slice(0, 40);
    const seat = fakeSeat({
      bytes: arrived,
      total: 100,
      chunk: 16,
      complete: false,
      stalledFrom: 32,
    });
    const first = await readWindow(seat, {
      digest: DIGEST,
      range: "bytes=0-99",
      waitMs: 1,
    });
    await expect(
      drain(windowStream(seat, { digest: DIGEST, first }))
    ).rejects.toThrow(/still-arriving/u);
  });
});

describe("a refusal becomes an answer", () => {
  it("carries the two numbers `still-arriving` is the only place to find", () => {
    const answer = refusalToAnswer(
      Object.assign(new Error("still-arriving: 512/4096"), {
        code: "still-arriving",
      })
    );
    expect(answer).toStrictEqual({
      kind: "still-arriving",
      received: 512,
      total: 4096,
      mediaType: "application/octet-stream",
    });
  });

  it("carries the settled size out of `unsatisfiable`", () => {
    expect(
      refusalToAnswer(
        Object.assign(new Error("unsatisfiable: 4096"), {
          code: "unsatisfiable",
        })
      )
    ).toStrictEqual({ kind: "unsatisfiable", size: 4096 });
  });

  it("treats anything else as not-found rather than guessing", () => {
    expect(refusalToAnswer(new Error("the socket died"))).toStrictEqual({
      kind: "not-found",
    });
    expect(
      refusalToAnswer(
        Object.assign(new Error("not-found: x"), { code: "not-found" })
      )
    ).toStrictEqual({ kind: "not-found" });
  });

  it("does not fall over on a malformed message", () => {
    const answer = refusalToAnswer(
      Object.assign(new Error("still-arriving: nonsense"), {
        code: "still-arriving",
      })
    ) as { received: number; total: number };
    expect(answer.received).toBe(0);
    expect(answer.total).toBe(0);
  });
});

describe("one window of bytes", () => {
  it("refuses an answer that is not bytes, rather than reading fields off it", async () => {
    const seat: MediaSeat = {
      request: async () => ({ t: "result", value: {} }),
    };
    await expect(
      readWindow(seat, { digest: DIGEST, range: undefined, waitMs: 1 })
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("passes the Range header through untouched", async () => {
    const seat = fakeSeat({ bytes: body });
    await readWindow(seat, { digest: DIGEST, range: "bytes=-10", waitMs: 1 });
    // NOT normalised, NOT parsed: the grammar lives in the sidecar.
    expect(seat.calls).toStrictEqual(["bytes=-10"]);
  });

  it("types the window it returns from the seat's own fields", async () => {
    const seat = fakeSeat({
      bytes: body.slice(0, 40),
      total: 100,
      complete: false,
    });
    const window_: Window_ = await readWindow(seat, {
      digest: DIGEST,
      range: "bytes=0-99",
      waitMs: 1,
    });
    expect(window_.total).toBe(100);
    expect(window_.complete).toBe(false);
    expect(window_.reqEnd).toBe(99);
  });
});
