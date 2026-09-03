import { describe, expect, it } from "vitest";

import {
  consumeSse,
  consumeSseFrames,
  frameData,
  isEndFrame,
  parseFrame,
  parseSseText,
} from "./turn-stream.js";
import type { TurnStreamEvent } from "./turn-stream.js";

const frame = (evt: TurnStreamEvent): string =>
  `event: ${evt.type}\ndata: ${JSON.stringify(evt)}`;

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe("turn-stream frame parsing", () => {
  it('extracts concatenated data lines, tolerating "data:" and "data: "', () => {
    expect(frameData('event: x\ndata:{"a":1}')).toBe('{"a":1}');
    expect(frameData('data: {"a":1}')).toBe('{"a":1}');
  });

  it("parses a frame by the JSON `type`, ignoring heartbeats and the end frame", () => {
    expect(
      parseFrame(frame({ type: "assistant.delta", delta: "hi" }))
    ).toStrictEqual({
      type: "assistant.delta",
      delta: "hi",
    });
    expect(parseFrame(": ping")).toBeNull();
    expect(parseFrame("event: end\ndata: {}")).toBeNull(); // `{}` has no type
    expect(parseFrame("data: not json")).toBeNull();
  });

  it("parseSseText splits a whole blob into typed events", () => {
    const blob = [
      ": banner",
      frame({ type: "assistant.start" }),
      frame({ type: "assistant.delta", delta: "a" }),
      frame({ type: "final", text: "a" }),
      "event: end\ndata: {}",
    ].join("\n\n");
    const types = parseSseText(blob).map((e) => e.type);
    expect(types).toStrictEqual([
      "assistant.start",
      "assistant.delta",
      "final",
    ]);
  });
});

describe(consumeSse, () => {
  it("dispatches every event, reassembling frames split across chunks", async () => {
    const full =
      [
        ": banner",
        frame({ type: "assistant.delta", delta: "Hel" }),
        frame({ type: "assistant.delta", delta: "lo" }),
        frame({ type: "final", text: "Hello" }),
        "event: end\ndata: {}",
      ].join("\n\n") + "\n\n";
    const mid = Math.floor(full.length / 2);
    const events: TurnStreamEvent[] = [];
    const res = await consumeSse(
      streamOf([full.slice(0, mid), full.slice(mid)]),
      (e) => events.push(e)
    );
    expect(events.map((e) => e.type)).toStrictEqual([
      "assistant.delta",
      "assistant.delta",
      "final",
    ]);
    expect(events[2]).toStrictEqual({ type: "final", text: "Hello" });
    expect(res.ended).toBe(true);
  });

  it("reports ended:false when the body closes WITHOUT the end frame (mid-turn drop) (#420)", async () => {
    const events: TurnStreamEvent[] = [];
    const res = await consumeSse(
      streamOf([frame({ type: "assistant.delta", delta: "partial" }) + "\n\n"]),
      (e) => events.push(e)
    );
    expect(events.map((e) => e.type)).toStrictEqual(["assistant.delta"]);
    expect(res.ended).toBe(false);
  });

  it("stops cleanly on an aborted signal, reporting ended:false (#420)", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: TurnStreamEvent[] = [];
    const res = await consumeSse(
      streamOf([frame({ type: "final", text: "x" }) + "\n\n"]),
      (e) => events.push(e),
      { signal: controller.signal }
    );
    expect(res.ended).toBe(false);
  });
});

describe(consumeSseFrames, () => {
  it("reassembles split frames and delivers them in wire order", async () => {
    const frames: string[] = [];
    await consumeSseFrames(
      streamOf(["data: first\n\nda", "ta: second\n\n"]),
      (frameLocal: string) => frames.push(frameLocal)
    );
    expect(frames).toStrictEqual(["data: first", "data: second"]);
  });
});

describe(isEndFrame, () => {
  it('detects the terminal end frame, tolerating "event:end" and "event: end"', () => {
    expect(isEndFrame("event: end\ndata: {}")).toBe(true);
    expect(isEndFrame("event:end\ndata: {}")).toBe(true);
    expect(isEndFrame(frame({ type: "final", text: "x" }))).toBe(false);
    expect(isEndFrame(": ping")).toBe(false);
  });
});
