import { describe, expect, it, vi } from "vitest";

import {
  CHANNEL_CORE,
  CHANNEL_LOCAL,
  createFrameReader,
  createMultiplexer,
  decodeLocal,
  encodeFrame,
  encodeLocal,
  judgeHelloOk,
  MAX_FRAME_BYTES,
  rendererHello,
} from "./seat-client-core.js";

describe("the frame", () => {
  it("is u32BE length over a channel byte, and the length counts the channel", () => {
    const framed = encodeFrame(CHANNEL_LOCAL, new TextEncoder().encode("{}"));
    expect(Array.from(framed.slice(0, 5))).toStrictEqual([
      0,
      0,
      0,
      3,
      CHANNEL_LOCAL,
    ]);
    expect(new TextDecoder().decode(framed.slice(5))).toBe("{}");
  });

  it("refuses a payload over the protocol's ceiling rather than sending it", () => {
    expect(() =>
      encodeFrame(CHANNEL_CORE, new Uint8Array(MAX_FRAME_BYTES))
    ).toThrow(/ceiling/u);
    // One byte under is fine: the ceiling counts the channel byte.
    expect(() =>
      encodeFrame(CHANNEL_CORE, new Uint8Array(MAX_FRAME_BYTES - 1))
    ).not.toThrow();
  });
});

describe("the reassembler", () => {
  it("yields nothing until a frame is whole, one byte at a time", () => {
    const reader = createFrameReader();
    const framed = encodeLocal({ t: "hello_ok" });
    const seen = [];
    for (const byte of framed) {
      seen.push(...reader.push(new Uint8Array([byte])));
    }
    expect(seen).toHaveLength(1);
    expect(decodeLocal(seen[0]!.payload)).toStrictEqual({ t: "hello_ok" });
    expect(reader.pending()).toBe(0);
  });

  it("yields two frames from one chunk and holds a partial third", () => {
    const reader = createFrameReader();
    const a = encodeLocal({ t: "a" });
    const b = encodeLocal({ t: "b" });
    const c = encodeLocal({ t: "c" });
    const joined = new Uint8Array(a.length + b.length + 3);
    joined.set(a, 0);
    joined.set(b, a.length);
    joined.set(c.slice(0, 3), a.length + b.length);
    const frames = reader.push(joined);
    expect(frames.map((frame) => decodeLocal(frame.payload).t)).toStrictEqual([
      "a",
      "b",
    ]);
    expect(reader.pending()).toBe(3);
    expect(reader.push(c.slice(3))).toHaveLength(1);
  });

  it("does not go negative on a length whose high bit is set", () => {
    const reader = createFrameReader();
    // 0x00040000 is exactly MAX_FRAME_BYTES; one more is refused. The bug this
    // guards is `buffer[0] << 24` producing a negative number, which would
    // read as a tiny frame and desynchronise the stream silently.
    expect(() => reader.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow(
      /not a frame/u
    );
  });

  it("refuses a zero-length frame: a frame with no channel tag", () => {
    const reader = createFrameReader();
    expect(() => reader.push(new Uint8Array([0, 0, 0, 0]))).toThrow(
      /not a frame/u
    );
  });

  it("keeps the core channel's bytes opaque", () => {
    const reader = createFrameReader();
    const envelope = new Uint8Array([8, 7, 18, 2, 1, 2]);
    const [frame] = reader.push(encodeFrame(CHANNEL_CORE, envelope));
    expect(frame!.channel).toBe(CHANNEL_CORE);
    expect(Array.from(frame!.payload)).toStrictEqual(Array.from(envelope));
  });
});

describe("the multiplexer", () => {
  const harness = () => {
    const sent: Uint8Array[] = [];
    const unsolicited: unknown[] = [];
    const mux = createMultiplexer({
      send: (bytes) => sent.push(bytes),
      onUnsolicited: (message) => unsolicited.push(message),
    });
    const lastSent = () => decodeLocal(sent[sent.length - 1]!.slice(5));
    return { mux, sent, unsolicited, lastSent };
  };

  it("mints monotonic ids that are never reused", async () => {
    const { mux, lastSent } = harness();
    const first = mux.request({
      t: "page",
      statement: "tally.vault",
      limit: 1,
    });
    expect(lastSent()["id"]).toBe(1);
    mux.deliver({ t: "page", id: 1, rows: [] });
    await expect(first).resolves.toMatchObject({ t: "page" });

    const second = mux.request({ t: "devices_list" });
    expect(lastSent()["id"]).toBe(2);
    mux.deliver({ t: "result", id: 2, value: {} });
    await second;
    // A LATE ANSWER to a settled id is not somebody else's reply: it has no
    // waiter, so it is handed to the listener rather than resolving request 3.
    const third = mux.request({ t: "devices_list" });
    mux.deliver({ t: "result", id: 1, value: { stale: true } });
    expect(mux.inFlight()).toBe(1);
    mux.deliver({ t: "result", id: 3, value: {} });
    await third;
    expect(mux.nextId()).toBe(4);
  });

  it("rejects with the seat's code, not a sentence match", async () => {
    const { mux } = harness();
    const pending = mux.request({ t: "blob_range", blob: "x" });
    mux.deliver({
      t: "error",
      id: 1,
      code: "still-arriving",
      message: "512/4096",
    });
    await expect(pending).rejects.toMatchObject({ code: "still-arriving" });
  });

  it("hands a state push to the listener every time after the first", async () => {
    const { mux, unsolicited } = harness();
    const subscribed = mux.request({ t: "subscribe_state" });
    mux.deliver({ t: "state", id: 1, state: { availability: "local" } });
    await subscribed;
    mux.deliver({ t: "state", id: 1, state: { availability: "unavailable" } });
    mux.deliver({ t: "closing", reason: "the shell asked" });
    expect(unsolicited).toHaveLength(2);
    expect(unsolicited[0]).toMatchObject({ t: "state" });
    expect(unsolicited[1]).toMatchObject({ t: "closing" });
  });

  it("fails every request in flight when the socket dies", async () => {
    const { mux } = harness();
    const pending = mux.request({ t: "devices_list" });
    expect(mux.inFlight()).toBe(1);
    mux.abort("the seat process died");
    await expect(pending).rejects.toThrow(/died/u);
    expect(mux.inFlight()).toBe(0);
  });

  it("rejects rather than throwing synchronously when a frame will not encode", async () => {
    const send = vi.fn<(bytes: Uint8Array) => void>(() => {
      throw new Error("EPIPE");
    });
    const mux = createMultiplexer({ send, onUnsolicited: () => {} });
    await expect(mux.request({ t: "page" })).rejects.toThrow(/EPIPE/u);
    expect(mux.inFlight()).toBe(0);
  });
});

describe("the handshake", () => {
  it("sends the nonce and this build's protocol", () => {
    expect(rendererHello("abc")).toStrictEqual({
      t: "hello",
      client: "renderer",
      nonce: "abc",
      protocol: 1,
    });
  });

  it("accepts a seat that answered and carries its mode through", () => {
    expect(
      judgeHelloOk({
        t: "hello_ok",
        instance: "abc",
        mode: "thin",
        protocol: 1,
      })
    ).toStrictEqual({ ok: true, instance: "abc", mode: "thin" });
    expect(
      judgeHelloOk({
        t: "hello_ok",
        instance: "abc",
        mode: "replicated",
        protocol: 1,
      }).mode
    ).toBe("replicated");
  });

  it("refuses a seat from another build, and says which failure it is", () => {
    const judged = judgeHelloOk({ t: "hello_ok", protocol: 2 });
    expect(judged.ok).toBe(false);
    expect(judged.reason).toMatch(/different builds/u);
  });

  it("passes the seat's own refusal sentence through rather than inventing one", () => {
    expect(
      judgeHelloOk({
        t: "refused",
        code: "foreign-instance",
        message: "that shell belongs to a different Centraid install",
      })
    ).toStrictEqual({
      ok: false,
      reason: "that shell belongs to a different Centraid install",
    });
  });

  it("refuses anything that is not a handshake at all", () => {
    expect(judgeHelloOk({ t: "page" }).ok).toBe(false);
  });
});
