// Tests for the fixed-delay ACP stub (#890 follow-up).
//
// The stub exists to make `sendToFirstToken` measurable on a device, and the
// device lane cannot run here — but the PROPERTY the measurement depends on can
// be tested at this tier, and it is the only property that matters: that the
// first token arrives after a known, controllable delay and not before. If that
// is false, every number the device lane reports is off by an unknown amount,
// and no amount of running it on a phone would reveal that.
//
// Both shapes are covered on purpose: `handleMessage` in-process (fast, exact)
// and the real spawned process over stdio (proves the plumbing, the framing and
// the `--version` probe the backend runs before it will use a binary at all).

import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FIRST_TOKEN_DELAY_MS,
  FIRST_TOKEN_DELAY_ENV,
  STUB_CHUNKS,
  handleMessage,
  resolveDelayMs,
} from "./fixed-delay-agent.mjs";

const AGENT = path.resolve(import.meta.dirname, "fixed-delay-agent.mjs");

/** Collect what `handleMessage` sends for one message. */
async function collect(
  msg,
  { delayMs = 0, sleep = async () => undefined } = {}
) {
  const sent = [];
  await handleMessage(msg, { send: (m) => sent.push(m), delayMs, sleep });
  return sent;
}

describe("resolveDelayMs", () => {
  it("defaults when unset", () => {
    expect(resolveDelayMs({})).toBe(DEFAULT_FIRST_TOKEN_DELAY_MS);
  });

  it("reads a configured delay", () => {
    expect(resolveDelayMs({ [FIRST_TOKEN_DELAY_ENV]: "80" })).toBe(80);
  });

  it("accepts zero as a real value rather than treating it as unset", () => {
    // `0` is falsy, so the obvious `raw || DEFAULT` would silently substitute
    // 250ms here and quietly invalidate any run that asked for no delay.
    expect(resolveDelayMs({ [FIRST_TOKEN_DELAY_ENV]: "0" })).toBe(0);
  });

  it.each(["", "soon", "-5", "NaN"])(
    "falls back rather than throwing on %o",
    (value) => {
      expect(resolveDelayMs({ [FIRST_TOKEN_DELAY_ENV]: value })).toBe(
        DEFAULT_FIRST_TOKEN_DELAY_MS
      );
    }
  );
});

describe("the ACP subset the gateway drives", () => {
  it("answers initialize with a usable protocol version", async () => {
    const [reply] = await collect({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe(1);
    expect(reply.result.authMethods).toStrictEqual([]);
  });

  it("opens a session", async () => {
    const [reply] = await collect({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
    });
    expect(reply.result.sessionId).toBe("mobile-ci-1");
  });

  it("streams every chunk before ending the turn", async () => {
    const sent = await collect({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "s" },
    });
    const chunks = sent
      .filter((m) => m.method === "session/update")
      .map((m) => m.params.update.content.text);
    expect(chunks).toStrictEqual([...STUB_CHUNKS]);
    // The result must come LAST: a client that sees end_turn first stops
    // listening, and the tokens it already emitted are never rendered.
    expect(sent.at(-1).result.stopReason).toBe("end_turn");
  });

  it("sleeps for the configured delay before the FIRST chunk, not after", async () => {
    // The load-bearing assertion of this whole file. The delay must be spent
    // before anything is sent, or the measured interval excludes it and the
    // subtraction the budget performs is wrong in the direction that flatters
    // the product.
    const order = [];
    await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "session/prompt", params: {} },
      {
        send: (m) =>
          order.push(m.method === "session/update" ? "chunk" : "end"),
        delayMs: 123,
        sleep: async (ms) => {
          order.push(`slept:${ms}`);
        },
      }
    );
    expect(order[0]).toBe("slept:123");
    expect(order[1]).toBe("chunk");
  });

  it("swallows a cancel notification instead of answering it", async () => {
    // No `id` on a notification. Replying would be a protocol violation; the
    // fallback branch below must not catch it.
    expect(
      await collect({ jsonrpc: "2.0", method: "session/cancel", params: {} })
    ).toStrictEqual([]);
  });

  it("returns method-not-found for anything else that carries an id", async () => {
    const [reply] = await collect({
      jsonrpc: "2.0",
      id: 5,
      method: "session/load",
    });
    expect(reply.error.code).toBe(-32_601);
  });
});

describe("the spawned process", () => {
  it("reports a version so the backend will accept the binary", async () => {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [AGENT, "--version"]);
      let stdout = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.on("error", reject);
      child.on("close", () => resolve(stdout));
    });
    expect(out.trim()).toBe("centraid-fixed-delay 1.0.0");
  });

  it("handshakes and streams over real newline-delimited stdio", async () => {
    const delayMs = 60;
    const child = spawn(process.execPath, [AGENT], {
      env: { ...process.env, [FIRST_TOKEN_DELAY_ENV]: String(delayMs) },
    });
    const lines = [];
    let buffer = "";
    let markFirstChunk = () => undefined;
    let markEndTurn = () => undefined;
    const firstChunkAt = new Promise((resolve) => {
      markFirstChunk = resolve;
    });
    // Awaited separately from the first chunk: resolving both on the same event
    // is what made an earlier draft of this test read `end_turn` off a stream
    // that had only produced its first token. The two are different moments and
    // the test needs both.
    const turnEnded = new Promise((resolve) => {
      markEndTurn = resolve;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line);
          lines.push(message);
          if (message.method === "session/update")
            markFirstChunk(performance.now());
          if (message.result?.stopReason !== undefined) markEndTurn(message);
        }
        newline = buffer.indexOf("\n");
      }
    });

    const write = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    write({ jsonrpc: "2.0", id: 1, method: "initialize" });
    write({ jsonrpc: "2.0", id: 2, method: "session/new" });
    const sentAt = performance.now();
    write({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "mobile-ci-1" },
    });

    const observed = (await firstChunkAt) - sentAt;
    const ended = await turnEnded;
    child.kill();

    // Asserted as a FLOOR only. A ceiling here would be a timing test on shared
    // CI hardware, which is the flake this repo keeps out of blocking lanes —
    // and the ceiling is the device lane's job anyway. What matters is that the
    // delay was really spent: an agent that replied instantly would make the
    // budget measure nothing.
    expect(observed).toBeGreaterThanOrEqual(delayMs);
    expect(ended.result.stopReason).toBe("end_turn");
    expect(
      lines
        .filter((m) => m.method === "session/update")
        .map((m) => m.params.update.content.text)
    ).toStrictEqual([...STUB_CHUNKS]);
  });
});
